//! S3-backed `StorageBackend` implementation for libunftp.
//!
//! Every FTP command (STOR/RETR/LIST/DELE/RNFR+RNTO/MKD/RMD) routes through
//! this module. Files land in MinIO/S3 under the user's UUID prefix so users
//! can never see each other's content. Uploads enforce:
//!
//! - The per-user disk quota, claimed atomically via the API before the
//!   first byte hits S3.
//! - For files with a video extension (mp4/mov/…), an advisory magic-byte
//!   check on the first 12 bytes. If the declared format doesn't match the
//!   content, the upload is silently drained (never lands in S3, never
//!   becomes an event) and the user gets an `invalid_file` notification —
//!   but the FTPS reply is still 226 success. All other extensions (txt,
//!   pdf, jpg, …) are accepted as-is without content inspection.
//!
//! Quota rejections map to FTP reply 552 (`ExceededStorageAllocation`) and
//! also publish a user-visible notification via the internal API.
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use tokio::io::AsyncReadExt;
use tracing::{debug, error, info, warn};
use unftp_core::storage::{Error, ErrorKind, Fileinfo, StorageBackend};

use crate::api::InternalApi;
use crate::metadata::ObjectMetadata;
use crate::s3::{Probe, S3};
use crate::streams::StreamsPublisher;
use crate::user::ClipnestUser;

/// Per-user cap on concurrent in-flight FTPS uploads.
///
/// Raised from 2 to 24: a rejected STOR is a LOST recording,
/// because cameras never retry a failed FTP upload. 2 was sized for "one
/// multi-channel camera plus an ad-hoc client", which silently made a backlog
/// drain — a camera reconnecting after an outage, or several cameras firing on
/// the same motion event — reject everything past the second file. 24 covers
/// 20 simultaneous recordings plus their snapshots.
///
/// Two things scale with this number, both accounted for:
///   * The MAX_UPLOAD_BYTES post-claim TOCTOU window widens to 100 GiB × 24.
///     That bound is a
///     sanity limit, not a realistic file size — camera clips are ~20 MB, so
///     the practical window is ~500 MB.
///   * Peak memory per in-flight upload (see MULTIPART_CHUNK in s3.rs), which
///     is why the chunk size dropped to 5 MiB and the pod limit rose to 2 GiB
///     in the same change.
const MAX_CONCURRENT_UPLOADS_PER_USER: u32 = 24;

/// RAII guard that decrements the per-user upload counter on drop.
/// Holds an `Arc` to the shared map so the guard can outlive `&self`
/// borrows. The counter row is left in place at zero — we don't bother
/// pruning, since the map is keyed by user UUID and the working set is
/// bounded by active user count, not request count.
struct UploadSlot {
    counters: Arc<DashMap<String, AtomicU32>>,
    user_uuid: String,
}

impl Drop for UploadSlot {
    fn drop(&mut self) {
        if let Some(entry) = self.counters.get(&self.user_uuid) {
            entry.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// Per-upload sanity cap. Bigger than any realistic plan (Pro = 10 GiB,
/// Max = 5 TiB but per-file even on Max) and covers smartphone 4K
/// recordings. Stops a buggy / malicious client from streaming
/// indefinitely to S3 (= burning storage cost) when there's no plan-side
/// constraint to back-pressure them. Quota enforcement runs post-upload
/// via `claim_disk_space_and_tidy`, so this is purely a safety bound.
const MAX_UPLOAD_BYTES: i64 = 100 * 1024 * 1024 * 1024;

/// S3-backed virtual filesystem for FTP.
///
/// Each user sees their own S3 prefix as the root directory.
/// FTP path "/" maps to S3 prefix "{user_uuid}/"
/// FTP path "/2026/04/file.mp4" maps to S3 key "{user_uuid}/2026/04/file.mp4"
#[derive(Clone)]
pub struct ClipnestStorage {
    s3: S3,
    api: InternalApi,
    streams: StreamsPublisher,
    /// Per-user in-flight upload counter. Keyed by `user_uuid`. Bounds the
    /// MAX_UPLOAD_BYTES × N concurrent-session TOCTOU window in
    /// `claim_disk_space_and_tidy` to MAX_UPLOAD_BYTES × MAX_CONCURRENT_UPLOADS_PER_USER.
    upload_counters: Arc<DashMap<String, AtomicU32>>,

}

impl fmt::Debug for ClipnestStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClipnestStorage").finish()
    }
}

/// Bucket a filename into the bounded `ext` label used by
/// `clipnest_ftps_uploads_aborted_total`. Never the raw name — that would be
/// an unbounded (and identifying) Prometheus label.
fn ext_bucket(filename: &str) -> &'static str {
    match filename
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => "mp4",
        Some("jpg") => "jpg",
        _ => "other",
    }
}

/// Everything needed to finish an upload once its bytes are in S3, in a form
/// that can be moved into a detached task (no `&self`, no borrows). Cloned so
/// both the streaming task and the still-connected `put` can hold one — only
/// whichever of them ends up owning the outcome actually uses it.
#[derive(Clone)]
struct CommitCtx {
    api: InternalApi,
    s3: S3,
    user_uuid: String,
    key: String,
    bucket: String,
    filename: String,
    /// FTP-visible path, for log lines and user-facing notification details.
    display_path: String,
}

/// Register an object that finished streaming to S3.
///
/// Shared by both completion paths: the normal one (the FTP client is still
/// connected and this result becomes its STOR reply) and the salvage one (the
/// client vanished mid-transfer and nobody is listening). `truncated` marks
/// the second case, so the row describes a genuinely shorter clip instead of
/// silently passing for a complete recording.
async fn commit_upload(
    ctx: &CommitCtx,
    size: i64,
    truncated: bool,
) -> unftp_core::storage::Result<u64> {
    // INVARIANT: on transient API failure DO NOT delete the S3 object —
    // fail the transfer so the camera retransmits (idempotent on
    // s3_key); if the camera gives up, the audit job reconciles within 6 h.
    let resp = ctx
        .api
        .file_complete(
            &ctx.user_uuid,
            &ctx.bucket,
            &ctx.key,
            &ctx.filename,
            size,
            truncated,
        )
        .await
        .map_err(|e| {
            error!(error = %e, key = %ctx.key, "file-complete failed after retries");
            Error::new(ErrorKind::LocalError, e)
        })?;

    if !resp.claimed {
        // quota rejection — preserve today's delete + notify + 552 semantics
        warn!(
            user_uuid = %ctx.user_uuid,
            file_size = size,
            "Disk quota exceeded (auto-delete OFF) — removing uploaded object"
        );
        if let Err(e) = ctx.s3.delete_object(&ctx.key).await {
            warn!(error = %e, key = %ctx.key, "Failed to delete object after quota rejection");
        }
        let api = ctx.api.clone();
        let uuid = ctx.user_uuid.clone();
        let path = ctx.display_path.clone();
        tokio::spawn(async move {
            api.publish_notification(
                &uuid,
                "storage_quota_exceeded",
                "Disk quota reached — upload rejected. Free up space or raise the limit.",
                Some(serde_json::json!({ "path": path, "attemptedBytes": size })),
            )
            .await;
        });
        return Err(Error::new(
            ErrorKind::ExceededStorageAllocationError,
            "Disk quota exceeded",
        ));
    }

    info!(
        user_uuid = %ctx.user_uuid,
        path = ?ctx.display_path,
        size = size,
        truncated = truncated,
        state = resp.state.as_deref().unwrap_or("?"),
        "Upload complete (sync ingest)"
    );
    Ok(size as u64)
}

/// Finish an upload whose FTP client disappeared mid-transfer.
///
/// The client closing the control connection makes libunftp cancel the STOR
/// task, which used to take the received bytes down with it: no log line, no
/// metric, no object — the recording was simply gone, and cameras do not
/// retry. Recordings were lost that way with a completely clean pod
/// log. The bytes we did receive are already a valid (shorter) MP4, and the
/// sidecar builder trims a truncated file to its last complete sample, so
/// committing them turns "recording lost" into "recording shorter".
async fn salvage_upload(ctx: CommitCtx, ext: &'static str, streamed: Result<i64, String>) {
    warn!(
        user_uuid = %ctx.user_uuid,
        path = ?ctx.display_path,
        ext = ext,
        "Upload cancelled mid-transfer (client closed the connection) — committing partial recording"
    );
    ctx.api.report_upload_aborted(ext, &ctx.user_uuid).await;

    match streamed {
        Ok(size) if size > 0 => {
            if let Err(e) = commit_upload(&ctx, size, true).await {
                warn!(
                    error = ?e, key = %ctx.key,
                    "Salvaged partial upload could not be registered — the audit cron reconciles it",
                );
            }
        }
        Ok(_) => {
            // Nothing arrived before the client vanished; there is no object
            // to register and nothing to clean up.
            debug!(key = %ctx.key, "Cancelled upload had no bytes — nothing to salvage");
        }
        Err(e) => {
            error!(error = %e, key = %ctx.key, "Cancelled upload also failed to stream to S3");
        }
    }
}

impl ClipnestStorage {
    pub fn new(
        s3: S3,
        api: InternalApi,
        streams: StreamsPublisher,
    ) -> Self {
        Self {
            s3,
            api,
            streams,
            upload_counters: Arc::new(DashMap::new()),
        }
    }

    /// Atomically reserve a per-user upload slot. Returns `None` when the
    /// user is already at `MAX_CONCURRENT_UPLOADS_PER_USER` in-flight; the
    /// caller should reject the upload with FTP reply 421 (`Service Not
    /// Available`). The returned guard releases the slot on drop, so a
    /// crashed/cancelled upload path doesn't leak the counter.
    fn try_reserve_upload_slot(&self, user_uuid: &str) -> Option<UploadSlot> {
        let entry = self
            .upload_counters
            .entry(user_uuid.to_string())
            .or_insert_with(|| AtomicU32::new(0));
        // Use compare_exchange in a small loop to avoid the race where two
        // tasks both see N < MAX and both increment past it.
        let mut current = entry.load(Ordering::Acquire);
        loop {
            if current >= MAX_CONCURRENT_UPLOADS_PER_USER {
                return None;
            }
            match entry.compare_exchange(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(UploadSlot {
                        counters: self.upload_counters.clone(),
                        user_uuid: user_uuid.to_string(),
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }

    /// Fire-and-forget user-facing notification — clones the API handle and
    /// the user UUID into a tokio task so callers don't have to repeat the
    /// `let api = self.api.clone(); let uuid = ...; tokio::spawn(async move
    /// { api.publish_notification(...).await; });` boilerplate at every
    /// quota / validation rejection point. Notifications are best-effort by
    /// design (see `InternalApi::publish_notification`); errors are logged
    /// inside the API method, never returned.
    fn notify_async(
        &self,
        user_uuid: &str,
        kind: &'static str,
        message: &'static str,
        details: serde_json::Value,
    ) {
        let api = self.api.clone();
        let uuid = user_uuid.to_string();
        tokio::spawn(async move {
            api.publish_notification(&uuid, kind, message, Some(details)).await;
        });
    }

    /// Resolve an FTP path to a safe S3 key under the user's prefix.
    /// Rejects path traversal attempts (`..`), null bytes, and other unsafe components.
    /// Fire-and-forget negative usage report. Usage accounting is best-effort:
    /// the FTP `250` reply must not block on the API round-trip, and the 1-min
    /// storage reconciler heals `disk_usage_bytes` from S3 if this is ever
    /// dropped (the batch-delete path already relies on exactly that). Mirrors
    /// `StreamsPublisher::publish_delete_notify`'s spawn-and-log shape.
    fn spawn_usage_decrement(&self, user_uuid: &str, size: i64) {
        let api = self.api.clone();
        let user_uuid = user_uuid.to_string();
        tokio::spawn(async move {
            if let Err(e) = api.report_usage(&user_uuid, -size, 0).await {
                warn!(error = %e, "Failed to report deletion usage");
            }
        });
    }

    fn s3_key(user: &ClipnestUser, path: &Path) -> Result<String, Error> {
        let path_str = path.to_string_lossy();

        // Reject null bytes
        if path_str.contains('\0') {
            return Err(Error::new(
                ErrorKind::PermanentFileNotAvailable,
                "Invalid path",
            ));
        }

        // Normalize: collect only safe path components
        let mut components = Vec::new();
        for comp in path.components() {
            match comp {
                std::path::Component::Normal(name) => {
                    let s = name.to_string_lossy();
                    if s.contains("..") {
                        return Err(Error::new(
                            ErrorKind::PermissionDenied,
                            "Path traversal not allowed",
                        ));
                    }
                    // Reject UUID-shaped directory names. A legitimate camera /
                    // user upload never names a folder after a UUID; the only
                    // way one shows up in the path is as an artifact of a
                    // client-side traversal attempt that curl resolved before
                    // sending (`ftp://host/../{other_uuid}/...` becomes
                    // `/{other_uuid}/...`). The chroot would then nest that
                    // UUID inside the uploader's prefix, producing a confusing
                    // `wideVideo` path that looks like a cross-user leak.
                    if is_uuid_shape(&s) {
                        return Err(Error::new(
                            ErrorKind::PermissionDenied,
                            "UUID-shaped directory name not allowed",
                        ));
                    }
                    components.push(s.into_owned());
                }
                std::path::Component::RootDir | std::path::Component::CurDir => continue,
                std::path::Component::ParentDir => {
                    return Err(Error::new(
                        ErrorKind::PermissionDenied,
                        "Path traversal not allowed",
                    ));
                }
                _ => continue,
            }
        }

        let safe_path = components.join("/");
        if safe_path.is_empty() {
            Ok(format!("{}/", user.user_uuid))
        } else {
            Ok(format!("{}/{}", user.user_uuid, safe_path))
        }
    }
}

/// Recognise the canonical 36-character UUID shape (8-4-4-4-12 hex with
/// dashes). Used by `s3_key` to reject path components that look like a
/// user UUID — see commentary at the call site.
/// Wall-clock ceiling on proving that one directory exists.
///
/// Sized against the CAMERA's patience, not against S3's. A Reolink gives up
/// around 25-30 s for the whole `CWD 2026` -> `CWD 09` -> `CWD 09` -> `STOR`
/// sequence, and a cut STOR is a permanently lost recording — cameras never
/// retry. Three CWDs x 2 s leaves ~20 s for the transfer itself, which is what
/// the surviving uploads actually needed (27-60 s was already past the
/// edge: most camera sessions never produced an upload).
///
/// Do NOT raise this to "ride out" a slow provider. The budget existing at all
/// is the point: past it we answer by assumption and let STOR be the real test,
/// instead of holding the control channel open until the camera hangs up.
const DIR_PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// Below this much remaining budget, skip the second probe instead of issuing
/// a call that cannot finish. Without the floor, a first probe that ate the
/// whole budget is followed by a doomed second one, which bills
/// `clipnest_ftps_dir_probe_timeouts_total` twice for a single CWD and spends
/// another S3 round-trip to learn nothing.
const DIR_PROBE_MIN_SLICE: std::time::Duration = std::time::Duration::from_millis(50);

/// `cwd`: may the client enter this directory?
///
/// OPTIMISTIC on `Unknown`. S3 has no real directories, so wrongly admitting a
/// client costs nothing — the STOR that follows creates the object at its key
/// regardless, and that STOR is the authoritative test of whether the write
/// works. The alternative is what shipped before this function existed: hold
/// the control channel while a degraded ListObjectsV2 grinds, and lose the
/// recording when the camera gives up.
fn cwd_admits(marker: Probe, listing: Probe) -> bool {
    match (marker, listing) {
        (Probe::Present, _) => true,
        (_, Probe::Present) => true,
        // Both probes answered, both said no. This is the only honest "no".
        (Probe::Absent, Probe::Absent) => false,
        // Anything inconclusive: let the client through.
        _ => true,
    }
}

/// `metadata`: should this path be reported as a directory?
///
/// CONSERVATIVE on `Unknown`, the exact opposite of `cwd_admits`, and the
/// asymmetry is deliberate. `metadata` is asked about a path that may be a
/// FILE; answering "directory" because a probe timed out would make MLSD/LIST
/// describe a recording as a folder. A failed probe here must fall through to
/// the file branch, which does its own HeadObject and can still succeed.
fn metadata_is_directory(marker: Probe, listing: Probe) -> bool {
    matches!(marker, Probe::Present) || matches!(listing, Probe::Present)
}

fn is_uuid_shape(s: &str) -> bool {
    if s.len() != 36 { return false; }
    let bytes = s.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => if *b != b'-' { return false; }
            _ => if !b.is_ascii_hexdigit() { return false; }
        }
    }
    true
}

/// Video extensions whose content we sanity-check via magic bytes. These are
/// also the extensions that downstream (`server/services/scanner.ts`
/// VIDEO_EXT_SET) turns into UI events. Any extension outside this list
/// (txt, pdf, jpg, …) is accepted by FTPS without content inspection — the
/// scanner ignores them too, so they exist in S3 but never become events.
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "3gp"];

fn extension_lower(filename: &str) -> String {
    filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_video_extension(filename: &str) -> bool {
    VIDEO_EXTENSIONS.contains(&extension_lower(filename).as_str())
}

/// Extensions Clipnest stores as individual files: recordings, camera
/// snapshots, and the handful of sidecar/metadata blobs cameras drop next to
/// them. A DELE whose final path segment carries one of these is
/// unambiguously a *file*, never one of the date-component directories
/// (`2026/04/15`) the prefix-fallback branch in `del` exists to wipe.
///
/// `del` uses this to pick the fast single-round-trip delete path WITHOUT a
/// discriminator HEAD: because the branch is chosen by name, a real file can
/// never be mis-routed into the directory sweep by a HEAD that lost the race
/// against its own concurrent DELETE (which would skip the per-object
/// delete-notify and orphan the event row — `stream:ftps-prefix-deleted` has
/// no consumer). Anything outside this list (no extension, or an unknown one)
/// falls back to the authoritative HEAD-first logic, so the directory case is
/// preserved exactly. Being conservative here only costs a missed speedup, a
/// false positive would skip a real directory sweep — hence the closed list.
const FILE_EXTENSIONS: &[&str] = &[
    // video (mirror of VIDEO_EXTENSIONS) + camera-native containers
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "3gp", "dav", "264", "h264",
    // snapshots / images
    "jpg", "jpeg", "png", "bmp", "gif", "webp",
    // sidecar / metadata blobs
    "txt", "json", "log", "idx", "dat", "xml",
];

fn is_known_file_extension(filename: &str) -> bool {
    FILE_EXTENSIONS.contains(&extension_lower(filename).as_str())
}

/// Container-level magic-byte sniff. Only meaningful for video extensions;
/// returns false for unknown extensions or buffers shorter than 12 bytes.
fn video_magic_matches(filename: &str, data: &[u8]) -> bool {
    if data.len() < 12 {
        return false;
    }
    match extension_lower(filename).as_str() {
        // ISO BMFF: bytes 4..8 == "ftyp"
        "mp4" | "m4v" | "mov" | "3gp" => &data[4..8] == b"ftyp",
        // EBML header: 1A 45 DF A3
        "mkv" | "webm" => data[0..4] == [0x1A, 0x45, 0xDF, 0xA3],
        // "RIFF....AVI "
        "avi" => &data[0..4] == b"RIFF" && &data[8..12] == b"AVI ",
        // MPEG-TS sync byte 0x47 at offset 0
        "ts" => data[0] == 0x47,
        _ => false,
    }
}

#[async_trait]
impl StorageBackend<ClipnestUser> for ClipnestStorage {
    type Metadata = ObjectMetadata;

    async fn metadata<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
    ) -> unftp_core::storage::Result<Self::Metadata> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;

        debug!(user_uuid = %user.user_uuid, path = ?ftp_path, s3_key = %key, "metadata");

        // Root is always a directory
        if key == format!("{}/", user.user_uuid) {
            return Ok(ObjectMetadata::directory());
        }

        // Check if it's a directory by looking for objects under this prefix
        let dir_prefix = if key.ends_with('/') {
            key.clone()
        } else {
            format!("{}/", key)
        };

        // Directory precedence is preserved from the unbounded version: a path
        // that is both a prefix and a key still reports as a directory. What
        // changed is the COST — this used to paginate the entire prefix just to
        // learn whether it was non-empty, on a call libunftp makes for every
        // directory stat.
        let started = std::time::Instant::now();
        let left = || DIR_PROBE_BUDGET.saturating_sub(started.elapsed());

        let marker = self
            .s3
            .dir_marker_exists(&dir_prefix, &user.encryption_salt, left())
            .await;
        let listing = if marker == Probe::Present || left() < DIR_PROBE_MIN_SLICE {
            Probe::Unknown
        } else {
            self.s3.prefix_exists(&dir_prefix, left()).await
        };

        if metadata_is_directory(marker, listing) {
            return Ok(ObjectMetadata::directory());
        }

        // Inconclusive probes deliberately fall through to the file branch
        // rather than guessing "directory" — see `metadata_is_directory`. The
        // HeadObject below is its own, independent answer.

        // Try as a file
        match self.s3.head_object_full(&key, &user.encryption_salt).await {
            Ok((size, modified)) => Ok(ObjectMetadata::file_with_modified(size as u64, modified)),
            Err(_) => {
                // Check for directory marker
                match self
                    .s3
                    .head_object(&dir_prefix, &user.encryption_salt)
                    .await
                {
                    Ok(_) => Ok(ObjectMetadata::directory()),
                    Err(_) => Err(Error::new(
                        ErrorKind::PermanentFileNotAvailable,
                        format!("{}: No such file or directory", ftp_path.display()),
                    )),
                }
            }
        }
    }

    async fn list<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
    ) -> unftp_core::storage::Result<Vec<Fileinfo<PathBuf, Self::Metadata>>> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;
        let full_prefix = if key.ends_with('/') {
            key
        } else {
            format!("{}/", key)
        };

        debug!(user_uuid = %user.user_uuid, path = ?ftp_path, prefix = %full_prefix, "list");

        let objects = self.s3.list_objects(&full_prefix).await.map_err(|e| {
            error!(error = %e, "S3 list error");
            Error::new(ErrorKind::LocalError, e)
        })?;

        let mut entries: HashMap<String, Fileinfo<PathBuf, ObjectMetadata>> = HashMap::new();

        for obj in &objects {
            let rel_key = &obj.key[full_prefix.len()..];
            if rel_key.is_empty() {
                continue;
            }

            let parts: Vec<&str> = rel_key.splitn(2, '/').collect();
            let name = parts[0];
            if name.is_empty() {
                continue;
            }

            if parts.len() == 1 {
                // Direct file
                entries.entry(name.to_string()).or_insert_with(|| Fileinfo {
                    path: PathBuf::from(name),
                    metadata: ObjectMetadata::file_with_modified(obj.size as u64, obj.last_modified),
                });
            } else {
                // Subdirectory — show only the first level
                entries.entry(name.to_string()).or_insert_with(|| Fileinfo {
                    path: PathBuf::from(name),
                    metadata: ObjectMetadata::directory(),
                });
            }
        }

        Ok(entries.into_values().collect())
    }

    async fn get<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
        start_pos: u64,
    ) -> unftp_core::storage::Result<Box<dyn tokio::io::AsyncRead + Send + Sync + Unpin>> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;

        debug!(user_uuid = %user.user_uuid, path = ?ftp_path, start_pos = start_pos, "get (download)");

        // Check transfer quota before download
        let transfer_check = self
            .api
            .check_transfer(&user.user_uuid)
            .await
            .map_err(|e| {
                warn!(error = %e, "Transfer check failed");
                Error::new(ErrorKind::LocalError, e)
            })?;

        if !transfer_check.within_limit {
            warn!(user_uuid = %user.user_uuid, "Transfer quota exceeded on download");
            self.notify_async(
                &user.user_uuid,
                "transfer_quota_exceeded",
                "Monthly transfer limit reached — downloads blocked until reset.",
                serde_json::json!({ "path": ftp_path.to_string_lossy(), "direction": "download" }),
            );
            return Err(Error::new(
                ErrorKind::ExceededStorageAllocationError,
                "Transfer quota exceeded",
            ));
        }

        let (stream, content_length) = self
            .s3
            .get_object(&key, &user.encryption_salt)
            .await
            .map_err(|e| {
                error!(error = %e, key = %key, "S3 get error");
                Error::new(ErrorKind::PermanentFileNotAvailable, e)
            })?;

        // Report download transfer usage — Fix 0B batches via the
        // in-process aggregator. The flush task in main.rs sends one
        // POST per user per 10 s window.
        if let Some(size) = content_length {
            self.api.enqueue_download_transfer(&user.user_uuid, size);
        }

        // Convert ByteStream to AsyncRead
        let reader = stream.into_async_read();

        if start_pos > 0 {
            // Skip bytes for resume support
            let mut reader = reader;
            let mut skipped = 0u64;
            let mut buf = vec![0u8; 8192];
            while skipped < start_pos {
                let to_read = std::cmp::min(buf.len() as u64, start_pos - skipped) as usize;
                let n = reader
                    .read(&mut buf[..to_read])
                    .await
                    .map_err(|e| Error::new(ErrorKind::LocalError, e))?;
                if n == 0 {
                    break;
                }
                skipped += n as u64;
            }
            Ok(Box::new(reader))
        } else {
            Ok(Box::new(reader))
        }
    }

    async fn put<
        P: AsRef<Path> + Send + fmt::Debug,
        R: tokio::io::AsyncRead + Send + Sync + Unpin + 'static,
    >(
        &self,
        user: &ClipnestUser,
        mut input: R,
        path: P,
        start_pos: u64,
    ) -> unftp_core::storage::Result<u64> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;

        // FTP resume: `REST <offset>` before STOR, or APPE (for which libunftp
        // passes the current object size). This parameter used to be ignored
        // outright — a resumed upload wrote its bytes from position 0,
        // silently replacing the object with just its tail instead of
        // completing it. Downloads had honoured `start_pos` since day one, so
        // the asymmetry was easy to miss.
        //
        // Resume matters because a cut-short upload is now KEPT (see
        // `salvage_upload`): the offset a client would restart from is exactly
        // the size of the partial object we already hold.
        let resuming = start_pos > 0;
        if resuming {
            // The offset must match the object we actually have, or the result
            // would be a file with a hole (or duplicated bytes) in it. Refusing
            // is the only safe answer — never guess.
            match self.s3.head_object(&key, &user.encryption_salt).await {
                Ok(existing) if existing as u64 == start_pos => {
                    info!(
                        user_uuid = %user.user_uuid, path = ?ftp_path, start_pos,
                        "Resuming upload from client offset"
                    );
                }
                Ok(existing) => {
                    warn!(
                        user_uuid = %user.user_uuid, path = ?ftp_path,
                        start_pos, existing,
                        "Rejecting resume — client offset does not match the stored object"
                    );
                    return Err(Error::new(
                        ErrorKind::PermanentFileNotAvailable,
                        "Restart offset does not match the stored file size",
                    ));
                }
                Err(e) => {
                    warn!(
                        error = %e, key = %key, start_pos,
                        "Rejecting resume — no stored object to resume from"
                    );
                    return Err(Error::new(
                        ErrorKind::PermanentFileNotAvailable,
                        "No partial upload to resume",
                    ));
                }
            }
        }

        let filename = ftp_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        info!(user_uuid = %user.user_uuid, path = ?ftp_path, s3_key = %key, "put (upload)");

        // Cap concurrent uploads per user — bounds the per-user TOCTOU window
        // in claim_disk_space_and_tidy.
        // The guard releases the slot on drop, so panics / early returns do
        // not leak the counter. Held until the function ends.
        let _upload_slot = match self.try_reserve_upload_slot(&user.user_uuid) {
            Some(slot) => slot,
            None => {
                warn!(
                    user_uuid = %user.user_uuid,
                    cap = MAX_CONCURRENT_UPLOADS_PER_USER,
                    "Rejecting upload — concurrent upload cap reached"
                );
                return Err(Error::new(
                    ErrorKind::TransientFileNotAvailable,
                    "Too many concurrent uploads for this account",
                ));
            }
        };

        // Check transfer quota before upload
        let transfer_check = self
            .api
            .check_transfer(&user.user_uuid)
            .await
            .map_err(|e| {
                error!(error = %e, "Transfer check failed");
                Error::new(ErrorKind::LocalError, e)
            })?;

        if !transfer_check.within_limit {
            warn!(user_uuid = %user.user_uuid, "Transfer quota exceeded");
            self.notify_async(
                &user.user_uuid,
                "transfer_quota_exceeded",
                "Monthly transfer limit reached — uploads blocked until reset.",
                serde_json::json!({ "path": ftp_path.to_string_lossy(), "direction": "upload" }),
            );
            return Err(Error::new(
                ErrorKind::ExceededStorageAllocationError,
                "Transfer quota exceeded",
            ));
        }

        // Disk-headroom pre-check. FTP STOR carries no file size, so
        // we can't reject based on the incoming file's bytes — but we CAN
        // early-reject the degenerate case where the account already has ZERO
        // disk headroom (disk_usage_bytes >= disk_space_bytes). Without this,
        // a user pinned at/over their disk cap streams the entire file to S3
        // before `claim_disk_space_and_tidy` rejects it post-upload with 552,
        // burning bandwidth + storage churn for a write that can never land.
        //
        // This is ADVISORY / early-reject only and intentionally narrow: it
        // fires solely at zero headroom. Partial-headroom uploads fall through
        // untouched and keep the existing accept-then-tidy semantics, so the
        // auto-delete-oldest "always succeed while temporarily over plan" path
        // is unaffected. The authoritative atomic claim stays post-upload, so
        // the short-TTL cache staleness here can never let a real over-quota
        // write commit (this only narrows the
        // window from the safe side, never widens it). A quota-fetch failure
        // is non-fatal: we log and fall through to the existing post-upload
        // enforcement rather than block uploads on an API hiccup.
        let quota_opt = match self.api.fetch_quota(&user.user_uuid).await {
            Ok(quota) => {
                if quota.disk_headroom_bytes() == 0 {
                    warn!(
                        user_uuid = %user.user_uuid,
                        disk_usage_bytes = quota.disk_usage_bytes,
                        disk_limit_bytes = quota.disk_limit_bytes,
                        "Disk quota exhausted — rejecting upload before streaming to S3"
                    );
                    self.notify_async(
                        &user.user_uuid,
                        "storage_quota_exceeded",
                        "Disk quota reached — upload rejected. Free up space or raise the limit.",
                        serde_json::json!({ "path": ftp_path.to_string_lossy(), "direction": "upload" }),
                    );
                    return Err(Error::new(
                        ErrorKind::ExceededStorageAllocationError,
                        "Disk quota exceeded",
                    ));
                }
                // Has headroom (or unlimited plan) — proceed; the post-upload
                // atomic claim remains the authority.
                Some(quota)
            }
            Err(e) => {
                warn!(
                    error = %e,
                    user_uuid = %user.user_uuid,
                    "Disk-headroom pre-check failed — proceeding; post-upload claim still enforces quota"
                );
                None
            }
        };

        // Narrow the per-stream byte cap to the user's remaining disk
        // headroom for limited, auto-delete-OFF accounts (which would be rejected
        // by the post-upload claim anyway). This bounds the per-user
        // concurrent-upload TOCTOU over-commit from MAX_UPLOAD_BYTES × N down to
        // ~headroom × N: a single over-quota STOR aborts at the headroom boundary
        // instead of streaming up to the 100 GiB sanity cap before
        // claim_disk_space_and_tidy deletes it. Auto-delete-ON / unlimited /
        // unknown-flag accounts keep the full sanity cap (see
        // QuotaResponse::upload_stream_cap), so the documented "always succeed
        // then tidy" path is untouched and no legit upload that fits is rejected.
        //
        // Why this is a mid-stream cap and NOT a true pre-stream size check:
        // FTP STOR carries no declared size. A pre-stream check would require an
        // ALLO (or SIZE) command before STOR, but neither real Reolink cameras
        // nor curl --upload-file (the camera-sim) send one, and the libunftp fork
        // we vendor treats ALLO as an un-parsed NOOP — it never reaches
        // StorageBackend::put. So the ONLY upfront rejection possible is the
        // zero-headroom case above (no bytes can ever fit). For an account that
        // has SOME headroom but receives a file bigger than it, the overage is
        // unknowable until the bytes cross the boundary; this cap makes that abort
        // happen as early as physically possible (at exactly `headroom` bytes)
        // rather than after the whole file. Data safety is unchanged either way —
        // the partial object is discarded and never appears in the grid.
        let upload_cap = quota_opt
            .as_ref()
            .map(|q| q.upload_stream_cap(MAX_UPLOAD_BYTES))
            .unwrap_or(MAX_UPLOAD_BYTES);

        // Read up to 12 bytes for advisory magic-byte sniff. Short files are
        // fine — we just have fewer bytes to check against. Network/client
        // errors here still abort the upload; that's a different failure mode
        // than "bytes arrived but didn't match a known video header".
        let mut magic_buf = [0u8; 12];
        let mut magic_len = 0usize;
        // A resumed stream starts mid-file, so its leading bytes are not a
        // container header — sniffing them would reject every resume.
        while !resuming && magic_len < magic_buf.len() {
            match input.read(&mut magic_buf[magic_len..]).await {
                Ok(0) => break, // EOF — file is shorter than 12 bytes
                Ok(n) => magic_len += n,
                Err(e) => {
                    error!(error = %e, "Failed to read upload magic bytes");
                    return Err(Error::new(ErrorKind::LocalError, e));
                }
            }
        }
        let magic_slice = &magic_buf[..magic_len];

        // Magic-byte check is advisory and only meaningful for video
        // extensions. A non-video extension (txt, pdf, jpg, …) skips the
        // check entirely and uploads as-is — the scanner ignores it downstream.
        // A video extension with a content mismatch (e.g. `.mp4` with no `ftyp`)
        // is treated as a "soft reject": drain the stream so the client sees
        // a clean transfer, notify the user, and return Ok(0) without writing
        // anything to S3.
        if !resuming && is_video_extension(&filename) && !video_magic_matches(&filename, magic_slice) {
            warn!(
                user_uuid = %user.user_uuid,
                path = ?ftp_path,
                "Video upload magic-byte mismatch — dropping silently (no 550, no S3 write)"
            );
            self.notify_async(
                &user.user_uuid,
                "invalid_file",
                "Upload discarded: the file's contents did not look like a valid video for its extension.",
                serde_json::json!({ "filename": filename, "reason": "magic_bytes" }),
            );
            // Drain the remainder of the input so the FTP client completes
            // its STOR transfer cleanly (otherwise it sees a premature close
            // and may report an error). We deliberately throw the bytes away.
            let mut sink = [0u8; 8192];
            loop {
                match input.read(&mut sink).await {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(_) => break, // Client disconnect is fine here.
                }
            }
            return Ok(0);
        }

        // Stream to S3 with a sanity cap (per-file 100 GiB). NO plan-based
        // pre-check: quota enforcement runs post-upload via
        // `claim_disk_space_and_tidy`, which unconditionally increments
        // `disk_usage_bytes` and (when the user has the auto-delete flag
        // on) schedules an async eviction task to bring usage back under
        // plan. This means an upload "always succeeds" for opted-in users
        // even if they're temporarily over quota — the cleanup catches up
        // in the background.
        // The stream runs in a DETACHED task, not inline. libunftp cancels the
        // STOR task the moment the client closes the control channel, and a
        // cancelled future runs no code at all — every byte already received
        // used to be discarded together with the half-built multipart upload.
        // Owning the reader in its own task decouples the two: the client can
        // vanish, the stream still drains to EOF, and `salvage_upload` commits
        // what arrived. `READ_IDLE_TIMEOUT` in s3.rs bounds the pathological
        // half-open socket so a detached task can never pin an upload slot.
        //
        // The oneshot is also how the task learns which case it is in: if the
        // send succeeds, `put` is still awaiting and owns the outcome; if it
        // fails, the receiver was dropped, meaning `put` was cancelled and
        // nobody will ever read the result — so the task finishes the ingest
        // itself. No flag, no race.
        let ctx = CommitCtx {
            api: self.api.clone(),
            s3: self.s3.clone(),
            user_uuid: user.user_uuid.clone(),
            key: key.clone(),
            bucket: self.s3.bucket_name().to_string(),
            filename: filename.clone(),
            display_path: ftp_path.to_string_lossy().into_owned(),
        };
        let ctx_for_ok = ctx.clone();
        let ext = ext_bucket(&filename);
        let magic_owned = magic_slice.to_vec();
        let salt = user.encryption_salt.clone();
        let s3 = self.s3.clone();
        let stream_key = key.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();

        // Resume is implemented by REPLAYING the stored prefix ahead of the
        // client's bytes rather than with UploadPartCopy. It costs one extra
        // read of the partial object, but it reuses the single streaming path
        // that every upload already exercises instead of introducing a second
        // one with its own SSE-C copy semantics — and the objects in question
        // are partial camera clips (tens of MB), not archives.
        let mut source: Box<dyn tokio::io::AsyncRead + Send + Unpin> = if resuming {
            let (stored, _) = self
                .s3
                .get_object(&key, &user.encryption_salt)
                .await
                .map_err(|e| {
                    error!(error = %e, key = %key, "Failed to read the object being resumed");
                    Error::new(ErrorKind::LocalError, e)
                })?;
            Box::new(stored.into_async_read().chain(input))
        } else {
            Box::new(input)
        };

        tokio::spawn(async move {
            // Hold the per-user upload slot for as long as bytes are actually
            // moving, not just as long as `put` is alive.
            let _slot = _upload_slot;
            let streamed = s3
                .put_object_stream(&stream_key, &magic_owned, &mut source, &salt, upload_cap)
                .await
                .map_err(|e| e.to_string());
            if let Err(streamed) = tx.send(streamed) {
                salvage_upload(ctx, ext, streamed).await;
            }
        });

        // A RecvError means the sender was dropped without sending, which can
        // only happen if the spawned task panicked — surface it as a transfer
        // error rather than reporting a phantom success.
        let streamed = rx.await.map_err(|_| {
            error!(key = %key, "Upload task ended without a result");
            Error::new(ErrorKind::LocalError, "upload task failed")
        })?;

        let size = match streamed {
            Ok(s) => s,
            Err(msg) => {
                error!(error = %msg, key = %key, "S3 streaming upload failed");
                if msg.starts_with("Upload exceeds") {
                    // The stream hit its byte cap. If we narrowed the cap to the
                    // user's disk headroom (upload_cap < MAX_UPLOAD_BYTES),
                    // this is a disk-quota rejection — not the 100 GiB per-file
                    // sanity limit — so surface it as a quota error + notification.
                    if upload_cap < MAX_UPLOAD_BYTES {
                        warn!(
                            user_uuid = %user.user_uuid,
                            upload_cap,
                            "Upload aborted at disk-headroom cap (over quota, auto-delete off)"
                        );
                        // This file is larger than the account's REMAINING disk
                        // space (the account is not at zero headroom — that case
                        // is caught upfront before any bytes stream — but this
                        // particular file would push it over). FTP STOR declares
                        // no size up front (cameras/curl never send ALLO), so the
                        // overage can only be detected once the stream crosses the
                        // remaining-headroom boundary; the partial object is
                        // discarded and nothing lands in the grid. Message says so
                        // plainly so the user knows the file didn't store and how
                        // to make it fit.
                        self.notify_async(
                            &user.user_uuid,
                            "storage_quota_exceeded",
                            "Upload rejected: this recording is larger than your remaining storage. The partial upload was discarded — free up space or raise the limit, then re-upload.",
                            serde_json::json!({
                                "path": ftp_path.to_string_lossy(),
                                "direction": "upload",
                                "reason": "exceeds_remaining_headroom",
                                "remainingBytes": upload_cap,
                            }),
                        );
                        return Err(Error::new(
                            ErrorKind::ExceededStorageAllocationError,
                            "File exceeds remaining disk quota — partial upload discarded",
                        ));
                    }
                    self.notify_async(
                        &user.user_uuid,
                        "invalid_file",
                        "Upload exceeded the per-file size limit (100 GiB). Split the recording or contact support.",
                        serde_json::json!({ "path": ftp_path.to_string_lossy(), "direction": "upload" }),
                    );
                    return Err(Error::new(
                        ErrorKind::ExceededStorageAllocationError,
                        "Upload exceeds per-file size limit",
                    ));
                }
                return Err(Error::new(ErrorKind::LocalError, msg));
            }
        };
        if size == 0 {
            warn!(user_uuid = %user.user_uuid, path = ?ftp_path, "Ignoring empty upload");
            let _ = self.s3.delete_object(&key).await;
            return Ok(0);
        }

        // R1 synchronous transactional ingest: one API call claims quota,
        // registers file_metadata and links the event (+ thumbnail job
        // server-side). Legacy async path (CLIPNEST_SYNC_INGEST=false) removed in R3.
        // `truncated = false`: reaching here means the stream ended while the
        // client was still connected, so the object holds the whole file.
        commit_upload(&ctx_for_ok, size, false).await
    }

    async fn del<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;

        info!(user_uuid = %user.user_uuid, path = ?ftp_path, "del");

        // Fast path: the final path segment carries a known file extension, so
        // the target is unambiguously a stored object (recording / snapshot /
        // sidecar) — never one of the date-component directories the prefix
        // fallback below exists to wipe. Issue the size HEAD and the
        // authoritative DELETE concurrently: on the common camera-delete this
        // collapses two sequential S3 round-trips into one. The branch is
        // chosen by NAME, not by the HEAD result, so a HEAD that 404s because
        // its own concurrent DELETE already won the race cannot mis-route a
        // real file into the prefix sweep (which would skip the per-object
        // delete-notify and orphan the event row — `stream:ftps-prefix-deleted`
        // has no consumer). We always emit the delete-notify here.
        let looks_like_file = ftp_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(is_known_file_extension)
            .unwrap_or(false);

        if looks_like_file {
            let (head_res, del_res) = tokio::join!(
                self.s3.head_object(&key, &user.encryption_salt),
                self.s3.delete_object(&key),
            );

            del_res.map_err(|e| {
                error!(error = %e, "S3 delete error");
                Error::new(ErrorKind::LocalError, e)
            })?;

            // Negative usage off the critical path. Size comes from the
            // concurrent HEAD; if the DELETE won the race the HEAD 404s and we
            // skip it — the 1-min storage reconciler heals disk_usage_bytes.
            if let Ok(size) = head_res {
                self.spawn_usage_decrement(&user.user_uuid, size);
            }

            // Notify event-manager to update or remove the DB record.
            self.streams.publish_delete_notify(&user.user_uuid, &key);

            return Ok(());
        }

        // Fallback (no extension / unknown extension — date directories,
        // extensionless names): keep the authoritative HEAD-first
        // discrimination so the directory sweep still runs for a prefix key.
        match self.s3.head_object(&key, &user.encryption_salt).await {
            Ok(size) => {
                self.s3.delete_object(&key).await.map_err(|e| {
                    error!(error = %e, "S3 delete error");
                    Error::new(ErrorKind::LocalError, e)
                })?;

                // Report negative usage off the critical path (see fast path).
                self.spawn_usage_decrement(&user.user_uuid, size);

                // Notify event-manager to update or remove DB record (fire-and-forget)
                self.streams.publish_delete_notify(&user.user_uuid, &key);
            }
            Err(_) => {
                // HEAD failed — treat the key as a directory prefix: list
                // whatever sits under it, batch-delete the survivors, and
                // publish a prefix-deleted event so event-manager can sweep
                // matching file_metadata rows + the event row.
                let dir_prefix = if key.ends_with('/') {
                    key.clone()
                } else {
                    format!("{}/", key)
                };

                let contents = self.s3.list_objects(&dir_prefix).await.map_err(|e| {
                    error!(error = %e, "S3 list error in del");
                    Error::new(ErrorKind::LocalError, e)
                })?;

                // Batch delete — S3's DeleteObjects takes 1000 keys per call,
                // so a directory with N files goes from N sequential HTTP
                // round-trips to ⌈N/1000⌉.
                if !contents.is_empty() {
                    let keys: Vec<String> = contents.iter().map(|o| o.key.clone()).collect();
                    self.s3.delete_objects(&keys).await.map_err(|e| {
                        error!(error = %e, "S3 batch delete error");
                        Error::new(ErrorKind::LocalError, e)
                    })?;

                    // Fan out delete/notify per object so event-manager can
                    // update or drop the affected DB rows immediately. Skip
                    // directory-marker keys (they never map to an event).
                    for k in keys.iter().filter(|k| !k.ends_with('/')) {
                        self.streams.publish_delete_notify(&user.user_uuid, k);
                    }
                }

                // Also try to delete the directory marker
                let _ = self.s3.delete_object(&dir_prefix).await;

                // Sweep file_metadata under this prefix even when `contents`
                // was empty — handles the case where S3 LIST returns nothing
                // but file_metadata rows still exist. Trim the trailing
                // slash; event-manager treats the value as a LIKE prefix,
                // not a directory marker.
                let prefix_payload = key.trim_end_matches('/');
                self.streams
                    .publish_prefix_deleted(&user.user_uuid, prefix_payload);
            }
        }

        Ok(())
    }

    async fn mkd<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;
        let dir_key = if key.ends_with('/') {
            key
        } else {
            format!("{}/", key)
        };

        info!(user_uuid = %user.user_uuid, path = ?ftp_path, "mkd");

        // Create a directory marker object
        self.s3
            .put_object(&dir_key, Bytes::new(), &user.encryption_salt)
            .await
            .map_err(|e| {
                error!(error = %e, "S3 put error in mkd");
                Error::new(ErrorKind::LocalError, e)
            })?;

        Ok(())
    }

    async fn rename<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        from: P,
        to: P,
    ) -> unftp_core::storage::Result<()> {
        let from_path = from.as_ref();
        let to_path = to.as_ref();
        let from_key = Self::s3_key(user, from_path)?;
        let to_key = Self::s3_key(user, to_path)?;

        info!(user_uuid = %user.user_uuid, from = ?from_path, to = ?to_path, "rename");

        // Decide file vs directory by probing the source with HEAD. The
        // previous implementation tried CopyObject first and fell through to
        // the directory path on ANY error, which silently swallowed real S3
        // failures (auth, SSE-C mismatch, bucket permissions) — the client
        // saw 250 OK while nothing actually moved. Using HEAD as a gate lets
        // copy errors surface to the FTP client as 550 instead.
        // Capture the source size from the HEAD probe — needed to re-ingest
        // the destination key below (file_complete wants the byte count).
        let source_size = self
            .s3
            .head_object(&from_key, &user.encryption_salt)
            .await
            .ok();
        let source_is_file = source_size.is_some();

        if source_is_file {
            // File rename: server-side S3 CopyObject + delete of the source.
            // Previously this did get_object + read_to_end + put_object, which
            // buffered the entire source file in RAM per concurrent rename — a
            // trivial OOM vector for any authenticated camera user. CopyObject
            // is a metadata op on the object store; no bytes flow through the FTPS
            // process, and transfer usage is not charged to the user.
            self.s3
                .copy_object(&from_key, &to_key, &user.encryption_salt)
                .await
                .map_err(|e| {
                    error!(error = %e, from = %from_key, to = %to_key, "S3 copy_object failed during rename");
                    Error::new(ErrorKind::LocalError, e)
                })?;

            self.s3
                .delete_object(&from_key)
                .await
                .map_err(|e| Error::new(ErrorKind::LocalError, e))?;

            // Re-ingest the destination key so it gets an event in real-time.
            // The old scanner re-indexed renamed keys via a scan-trigger
            // publish; R3 removed the scanner, so without this a temp-name→
            // final rename (Reolink uploads to a temp name then renames to
            // .mp4) — or any rename to a fresh canonical name — would leave the
            // moved bytes with no event until the 6 h audit reconciler. Mirror
            // put()'s file_complete. Best-effort: the bytes are already moved,
            // so a failure here must NOT fail the rename (and on quota
            // rejection we must NOT delete the destination — the audit cron
            // reconciles either way); log and continue.
            if let Some(size) = source_size {
                let to_filename = to_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if let Err(e) = self
                    .api
                    .file_complete(
                        &user.user_uuid,
                        self.s3.bucket_name(),
                        &to_key,
                        &to_filename,
                        size,
                        // A rename moves bytes that were already fully
                        // received — never a truncated object.
                        false,
                    )
                    .await
                {
                    warn!(
                        error = %e, to = %to_key,
                        "file_complete after rename failed — audit cron will reconcile the new key",
                    );
                }
            }

            // Old key is gone — drop its event reference (and let the
            // delete-notify handler decrement disk usage for the source).
            self.streams.publish_delete_notify(&user.user_uuid, &from_key);

            return Ok(());
        }

        // Directory rename: CopyObject each child key, then DeleteObject the
        // source prefix. Same memory-safety rationale as the file path above.
        let from_prefix = if from_key.ends_with('/') {
            from_key.clone()
        } else {
            format!("{}/", from_key)
        };
        let to_prefix = if to_key.ends_with('/') {
            to_key.clone()
        } else {
            format!("{}/", to_key)
        };

        let contents = self
            .s3
            .list_objects(&from_prefix)
            .await
            .map_err(|e| Error::new(ErrorKind::LocalError, e))?;

        // An empty listing means the source exists as neither a file (HEAD
        // would have succeeded) nor a directory prefix — this is the bug
        // that used to return 250 OK after a no-op. Surface it as an error
        // so the FTP client gets a 550 and the operator sees the failure.
        if contents.is_empty() {
            error!(
                user_uuid = %user.user_uuid,
                from = %from_key,
                "rename target not found as file or directory"
            );
            return Err(Error::new(
                ErrorKind::PermanentFileNotAvailable,
                "rename source not found",
            ));
        }

        for obj in &contents {
            let suffix = &obj.key[from_prefix.len()..];
            let new_key = format!("{}{}", to_prefix, suffix);

            self.s3
                .copy_object(&obj.key, &new_key, &user.encryption_salt)
                .await
                .map_err(|e| {
                    error!(error = %e, from = %obj.key, to = %new_key, "S3 copy_object failed during directory rename");
                    Error::new(ErrorKind::LocalError, e)
                })?;

            self.s3
                .delete_object(&obj.key)
                .await
                .map_err(|e| Error::new(ErrorKind::LocalError, e))?;
        }

        Ok(())
    }

    async fn rmd<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        // Same as del for S3 virtual directories
        self.del(user, path).await
    }

    async fn cwd<P: AsRef<Path> + Send + fmt::Debug>(
        &self,
        user: &ClipnestUser,
        path: P,
    ) -> unftp_core::storage::Result<()> {
        let ftp_path = path.as_ref();
        let key = Self::s3_key(user, ftp_path)?;

        debug!(user_uuid = %user.user_uuid, path = ?ftp_path, "cwd");

        // Root always exists
        if key == format!("{}/", user.user_uuid) {
            return Ok(());
        }

        let dir_prefix = if key.ends_with('/') {
            key.clone()
        } else {
            format!("{}/", key)
        };

        // One budget for the whole check, shared across both probes — NOT one
        // per call. Two 2 s probes per CWD would be 12 s across the three CWDs
        // a camera walks before STOR, which is most of its patience spent
        // proving directories exist.
        let started = std::time::Instant::now();
        let left = || DIR_PROBE_BUDGET.saturating_sub(started.elapsed());

        // Marker first. `mkd` writes a zero-byte marker for every directory it
        // creates, so for a camera that MKDs before storing this single cheap
        // HeadObject ends the question with no listing at all. The old order
        // was the reverse — unbounded ListObjectsV2 first, HEAD only as a
        // fallback — which put the slowest S3 verb in front of the cheapest on
        // the hottest path in the server.
        let marker = self
            .s3
            .dir_marker_exists(&dir_prefix, &user.encryption_salt, left())
            .await;
        if marker == Probe::Present {
            return Ok(());
        }

        // No marker: a camera may STOR straight into a prefix it never created.
        let listing = if left() >= DIR_PROBE_MIN_SLICE {
            self.s3.prefix_exists(&dir_prefix, left()).await
        } else {
            Probe::Unknown
        };

        if cwd_admits(marker, listing) {
            if marker == Probe::Unknown || listing == Probe::Unknown {
                warn!(
                    user_uuid = %user.user_uuid,
                    path = ?ftp_path,
                    ?marker,
                    ?listing,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "cwd admitted without proof — S3 did not answer in budget; STOR is now the real test"
                );
            }
            Ok(())
        } else {
            Err(Error::new(
                ErrorKind::PermanentDirectoryNotAvailable,
                format!("{}: No such directory", ftp_path.display()),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ext_bucket;
    use super::is_known_file_extension;
    use super::is_uuid_shape;
    use super::{MAX_CONCURRENT_UPLOADS_PER_USER, UploadSlot};
    use dashmap::DashMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    ///story: Odrzucony STOR to UTRACONE nagranie — kamera nigdy nie ponawia. Limit 2 równoległych uploadów cicho odrzucał wszystko powyżej drugiego pliku, gdy kamera nadrabiała zaległości albo kilka kamer wyzwoliło się na tym samym ruchu. 24 pokrywa 20 jednoczesnych nagrań plus snapshoty, a zwolniony slot musi natychmiast wracać do puli.
    #[test]
    fn upload_slots_cover_twenty_simultaneous_recordings() {
        const { assert!(MAX_CONCURRENT_UPLOADS_PER_USER >= 20) };
        let counters: Arc<DashMap<String, AtomicU32>> = Arc::new(DashMap::new());
        let take = || {
            let entry = counters
                .entry("u".to_string())
                .or_insert_with(|| AtomicU32::new(0));
            let mut cur = entry.load(Ordering::Acquire);
            loop {
                if cur >= MAX_CONCURRENT_UPLOADS_PER_USER {
                    return None;
                }
                match entry.compare_exchange(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire) {
                    Ok(_) => {
                        return Some(UploadSlot {
                            counters: counters.clone(),
                            user_uuid: "u".to_string(),
                        });
                    }
                    Err(observed) => cur = observed,
                }
            }
        };

        let held: Vec<UploadSlot> = (0..MAX_CONCURRENT_UPLOADS_PER_USER)
            .map(|_| take().expect("every slot up to the cap must be grantable"))
            .collect();
        assert!(take().is_none(), "the cap must actually bind");

        drop(held);
        assert!(take().is_some(), "slots must return to the pool on drop");
    }

    #[test]
    fn ext_bucket_keeps_the_prometheus_label_bounded() {
        assert_eq!(ext_bucket("Middle_00_20260726143201.mp4"), "mp4");
        assert_eq!(ext_bucket("Middle_00_20260726143209.JPG"), "jpg");
        // Everything else collapses into one bucket — the label must never
        // grow a value an uploader can choose.
        assert_eq!(ext_bucket("Driveway_00_20260726142241.txt"), "other");
        assert_eq!(ext_bucket("clip.mov"), "other");
        assert_eq!(ext_bucket("no-extension"), "other");
        assert_eq!(ext_bucket(""), "other");
    }

    #[test]
    fn known_file_extension_accepts_recordings_and_snapshots() {
        assert!(is_known_file_extension("Driveway_00_20260525172125.mp4"));
        assert!(is_known_file_extension("Driveway_00_20260525172125.jpg"));
        assert!(is_known_file_extension("clip.mov"));
        assert!(is_known_file_extension("snapshot.jpeg"));
        assert!(is_known_file_extension("stream.dav"));
    }

    #[test]
    fn known_file_extension_is_case_insensitive() {
        assert!(is_known_file_extension("CLIP.MP4"));
        assert!(is_known_file_extension("SNAP.JPG"));
    }

    #[test]
    fn known_file_extension_rejects_date_directory_components() {
        // These reach `del` when a client DELEs a folder — they MUST take the
        // HEAD-authoritative fallback so the prefix sweep still runs.
        assert!(!is_known_file_extension("2026"));
        assert!(!is_known_file_extension("04"));
        assert!(!is_known_file_extension("15"));
    }

    #[test]
    fn known_file_extension_rejects_extensionless_and_dotted_dir_names() {
        // Extensionless camera name → fallback (HEAD decides).
        assert!(!is_known_file_extension("Cam_00_20260414100000"));
        // A directory that happens to contain a dot must NOT be fast-pathed,
        // or its contents would be orphaned (the sweep would be skipped).
        assert!(!is_known_file_extension("My.Clips"));
        assert!(!is_known_file_extension(""));
    }

    #[test]
    fn is_uuid_shape_recognises_canonical_uuid() {
        assert!(is_uuid_shape("5d5ca047-6f67-4f08-9cf4-d85a42c5d870"));
    }

    #[test]
    fn is_uuid_shape_rejects_normal_directory_names() {
        assert!(!is_uuid_shape("2026"));
        assert!(!is_uuid_shape("CamA_00_20260414100000"));
        assert!(!is_uuid_shape(""));
        assert!(!is_uuid_shape("5d5ca047-6f67-4f08-9cf4-d85a42c5d87"));   // 35 chars
        assert!(!is_uuid_shape("5d5ca047-6f67-4f08-9cf4-d85a42c5d8700")); // 37 chars
    }

    #[test]
    fn is_uuid_shape_rejects_dash_position_drift() {
        // valid length but dashes in wrong slots
        assert!(!is_uuid_shape("5d5ca0476-f67-4f08-9cf4-d85a42c5d870"));
    }

    #[test]
    fn is_uuid_shape_rejects_non_hex_chars() {
        assert!(!is_uuid_shape("zd5ca047-6f67-4f08-9cf4-d85a42c5d870"));
    }

    ///story: To jest regresja na utratę nagrań. Gdy S3 nie odpowie w budżecie, `cwd` MUSI wpuścić klienta: S3 nie ma prawdziwych katalogów, więc błędne wpuszczenie nie kosztuje nic (STOR i tak utworzy obiekt pod swoim kluczem i to on jest prawdziwym testem zapisu), a alternatywa to trzymanie kanału kontrolnego aż kamera się rozłączy — czyli nagranie przepadłe na zawsze, bo kamery nie ponawiają. Jedyne uczciwe "nie" to dwie zgodne odpowiedzi "nie ma".
    #[test]
    fn cwd_refuses_only_when_both_probes_actually_said_no() {
        use super::cwd_admits;
        use crate::s3::Probe::{Absent, Present, Unknown};

        // The one and only refusal.
        assert!(!cwd_admits(Absent, Absent));

        // Proof of existence from either probe.
        assert!(cwd_admits(Present, Absent));
        assert!(cwd_admits(Absent, Present));
        assert!(cwd_admits(Present, Present));
        assert!(cwd_admits(Present, Unknown));
        assert!(cwd_admits(Unknown, Present));

        // Inconclusive — admit, and let STOR be the real test.
        assert!(
            cwd_admits(Unknown, Unknown),
            "a degraded S3 must not become a fabricated 550 that costs a recording",
        );
        assert!(cwd_admits(Absent, Unknown));
        assert!(cwd_admits(Unknown, Absent));
    }

    ///story: `metadata` rozstrzyga `Unknown` ODWROTNIE niż `cwd` i ta asymetria jest celowa. Pyta się o ścieżkę, która może być PLIKIEM, więc odpowiedź "katalog" tylko dlatego, że sonda nie zdążyła, kazałaby MLSD/LIST opisać nagranie jako folder. Nierozstrzygnięta sonda musi spaść do gałęzi plikowej, która ma własne HeadObject i wciąż może się udać.
    #[test]
    fn metadata_never_claims_directory_on_an_unanswered_probe() {
        use super::metadata_is_directory;
        use crate::s3::Probe::{Absent, Present, Unknown};

        // Only a positive answer makes it a directory.
        assert!(metadata_is_directory(Present, Absent));
        assert!(metadata_is_directory(Absent, Present));
        assert!(metadata_is_directory(Present, Unknown));
        assert!(metadata_is_directory(Unknown, Present));

        // Everything inconclusive falls through to the file branch.
        assert!(
            !metadata_is_directory(Unknown, Unknown),
            "a timed-out probe must not turn a recording into a folder",
        );
        assert!(!metadata_is_directory(Absent, Unknown));
        assert!(!metadata_is_directory(Unknown, Absent));
        assert!(!metadata_is_directory(Absent, Absent));
    }

    ///story: Budżet sondy jest skalibrowany do CIERPLIWOŚCI KAMERY, nie do S3. Reolink porzuca cały ciąg `CWD`×3 + `STOR` po ~25-30 s, a ucięty STOR to trwale utracone nagranie. Trzy CWD po 2 s zostawiają ~20 s na sam transfer. Podniesienie tego, żeby "przeczekać" wolnego dostawcę, odwraca cel budżetu.
    #[test]
    fn dir_probe_budget_leaves_the_camera_time_to_actually_upload() {
        use super::DIR_PROBE_BUDGET;

        let three_cwds = DIR_PROBE_BUDGET * 3;
        assert!(
            three_cwds <= std::time::Duration::from_secs(6),
            "CWD×3 would spend {three_cwds:?} just proving directories exist",
        );
        assert!(
            DIR_PROBE_BUDGET >= std::time::Duration::from_millis(500),
            "too tight — ordinary provider jitter would report as a timeout",
        );
    }
}
