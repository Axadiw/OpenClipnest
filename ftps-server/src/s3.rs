use std::fmt;

use aws_credential_types::Credentials;
use aws_sdk_s3::{
    config::{retry::RetryConfig, Builder as S3ConfigBuilder, Region},
    error::SdkError,
    operation::head_object::HeadObjectError,
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
    Client as S3Client,
};
use aws_smithy_http_client::{
    tls::{self, TlsContext, TrustStore},
    Builder as HttpClientBuilder,
};
use bytes::Bytes;
use tokio::io::AsyncReadExt;
use tracing::{debug, error, info, warn};

use crate::metrics::{global, timed, timed_where, timed_within_on, S3Op};

/// Does this HeadObject failure mean S3 broke?
///
/// A 404 does not. `storage.rs::metadata` probes a key and falls back to a
/// directory marker when it is absent, so "no such object" is the answer the
/// FTPS server asked for on every directory stat — not a fault. Keeping those
/// out of `clipnest_ftps_s3_errors_total` is what lets that counter mean
/// "recordings are being lost", which is exactly what its alert claims.
fn head_object_failed(err: &SdkError<HeadObjectError>) -> bool {
    !matches!(err, SdkError::ServiceError(e) if e.err().is_not_found())
}

/// Multipart part size, pinned to the S3 minimum for non-final parts.
///
/// Sized DOWN from 8 MiB when the per-user upload cap was raised to 24: peak
/// memory per in-flight upload is `READ_BUF + (1 + MULTIPART_CONCURRENCY) *
/// MULTIPART_CHUNK`, so 8 MiB × 24 concurrent uploads would have put a single
/// user at ~600 MiB on a 1 GiB pod. At 5 MiB that is ~16 MiB per upload
/// (~384 MiB for a fully saturated user), which the raised 2 GiB limit
/// absorbs comfortably. Smaller parts also mean a cut-short upload has
/// committed more of its bytes at any given moment.
const MULTIPART_CHUNK: usize = 5 * 1024 * 1024;

/// Read buffer size. Bigger = fewer syscalls + TLS record round-trips.
/// 1 MiB is a sweet spot — large enough to saturate a typical 1 Gbps local link,
/// small enough that the encoder keeps its latency bounded.
const READ_BUF: usize = 1024 * 1024;

/// Max concurrent S3 multipart part uploads in flight per file. Parts upload
/// independently (only part_number matters to S3), so overlapping them with
/// the client-side read hides the S3 round-trip behind the next part's TLS
/// buffer fill.
const MULTIPART_CONCURRENCY: usize = 2;

/// Give up waiting for more client bytes after this long and treat the stream
/// as ended, committing whatever arrived.
///
/// Uploads now stream in a task detached from the FTP control channel so a
/// client that disappears mid-transfer doesn't take its bytes down with it —
/// which means a half-open data socket (camera powered off mid-STOR, a NAT
/// silently dropping the flow) would otherwise pin that task, and the per-user
/// upload slot it holds, until the OS TCP timeout. Minutes to hours.
///
/// 120 s is far longer than any real inter-packet gap: the slowest transfer
/// observed on a congested LTE uplink (~130 KB/s) still moved
/// bytes every few hundred milliseconds. A stream that has delivered nothing
/// at all for two minutes is not slow, it is gone.
const READ_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

use crate::config::Config;
use crate::encryption::{derive_user_key, ssec_headers};

/// S3 client wrapper with SSE-C encryption support.
#[derive(Clone)]
pub struct S3 {
    client: S3Client,
    bucket: String,
    master_key: String,
}

impl fmt::Debug for S3 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `master_key` is the encryption root secret (HKDF IKM for every SSE-C
        // key). `S3` lives inside `ClipnestStorage`, which libunftp can Debug
        // via its session instrument — `#[derive(Debug)]` printed the master
        // key in plaintext (after dumping the entire AWS client config).
        // Redact the key and drop the noisy client; `bucket` isn't secret and
        // helps ops correlate.
        f.debug_struct("S3")
            .field("bucket", &self.bucket)
            .field("master_key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// Answer to one bounded existence probe.
///
/// `Unknown` is the load-bearing variant: it means "S3 did not tell us inside
/// the budget". The two callers resolve it in OPPOSITE directions on purpose —
/// `cwd` treats it as "exists" so the camera proceeds to STOR (the real test),
/// while `metadata` must not claim "directory" about something it failed to
/// inspect. Collapsing this into a bool is how the optimism leaks into the
/// wrong call site.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    Present,
    Absent,
    Unknown,
}

#[derive(Debug)]
pub struct S3Object {
    pub key: String,
    pub size: i64,
    /// LastModified from S3, mapped to SystemTime. None when the SDK
    /// didn't return a timestamp (shouldn't happen for normal objects).
    pub last_modified: Option<std::time::SystemTime>,
}

impl S3 {
    pub fn new(config: &Config) -> Self {
        let creds = Credentials::new(
            &config.s3_access_key,
            &config.s3_secret_key,
            None,
            None,
            "clipnest-ftps",
        );

        let mut builder = S3ConfigBuilder::new()
            .endpoint_url(&config.s3_endpoint)
            .region(Region::new("us-east-1"))
            .credentials_provider(creds)
            .force_path_style(true)
            // `standard`, not `adaptive`, and the attempt count is deliberately
            // UNCHANGED at 6.
            //
            // The retries themselves are load-bearing: a transient S3 blip on
            // complete_multipart destroys a recording outright, and cameras
            // never re-send. Lowering the count to make the latency histogram
            // prettier would trade recordings for a nicer graph.
            //
            // What `adaptive` adds on top of `standard` is a CLIENT-SIDE rate
            // limiter that measures throttling responses and then delays our own
            // sends to smooth them out. It is designed for fleets large enough to
            // be throttled by the service. This server runs at 0.26 req/s
            // average, 10 req/s at the 24 h peak (measured across
            // every pod) — orders of magnitude below any quota, so the limiter can
            // never protect us and can only add delay. Worse, it adds that delay
            // in exactly the wrong moment: during a provider latency event it
            // starts holding requests back, lengthening the stall it is reacting
            // to. `standard` keeps the exponential backoff and the retry-quota
            // token bucket that prevents retry storms, and drops the
            // self-throttling.
            //
            // Note what this does NOT fix: `metrics::timed_where_on` wraps the
            // whole `send()`, so one observation still covers up to 6 attempts
            // plus their backoff. That is time-to-succeed, not single-request
            // latency, and `FtpsS3LatencyHigh`'s description says so.
            .retry_config(RetryConfig::standard().with_max_attempts(6))
            .behavior_version_latest();

        // Always pin the rustls/aws-lc HTTPS connector (rustls 0.23) so the SDK
        // never falls back to its legacy default connector (rustls 0.21 + webpki
        // 0.101 — RUSTSEC). With no custom CA bundle it uses the platform's
        // native root store, matching the old default client's trust.
        let mut http = HttpClientBuilder::new()
            .tls_provider(tls::Provider::Rustls(tls::rustls_provider::CryptoMode::AwsLc));
        if let Some(ca_path) = &config.s3_ca_bundle {
            let ca_bytes = std::fs::read(ca_path)
                .unwrap_or_else(|e| panic!("Cannot read CLIPNEST_S3_CA_BUNDLE {ca_path}: {e}"));
            let trust_store = TrustStore::empty().with_pem_certificate(ca_bytes);
            let tls_ctx = TlsContext::builder()
                .with_trust_store(trust_store)
                .build()
                .expect("Failed to build TLS context from CA bundle");
            http = http.tls_context(tls_ctx);
        }
        builder = builder.http_client(http.build_https());

        let client = S3Client::from_conf(builder.build());

        Self {
            client,
            bucket: config.s3_recordings_bucket.clone(),
            master_key: config.encryption_master_key.clone(),
        }
    }

    fn get_ssec(&self, user_salt: &str) -> (String, String, String) {
        let key = derive_user_key(&self.master_key, user_salt);
        ssec_headers(&key)
    }

    /// Recordings bucket name. Exposed so `storage.rs` can pass it to the
    /// internal API when registering uploads in the FIFO eviction queue.
    pub fn bucket_name(&self) -> &str {
        &self.bucket
    }

    pub async fn put_object(
        &self,
        key: &str,
        data: Bytes,
        user_salt: &str,
    ) -> Result<(), aws_sdk_s3::Error> {
        let len = data.len() as i64;

        debug!(key = key, size = len, "Uploading to S3");

        let mut req = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(data))
            .content_length(len);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        timed(S3Op::Put, req.send()).await?;

        Ok(())
    }

    /// Stream an upload from `first_bytes` + `reader` into S3.
    ///
    /// Uses a single PUT for small files (< `MULTIPART_CHUNK`); multipart PUT for larger ones.
    /// Returns the total bytes uploaded as `i64`.
    ///
    /// The caller passes `first_bytes` separately because they may have been read already
    /// (e.g. for magic-bytes validation). They are prepended to the stream transparently.
    ///
    /// Multipart parts upload concurrently (up to `MULTIPART_CONCURRENCY` in flight),
    /// so the per-part S3 round-trip overlaps with reading the next part from the
    /// client. This is the difference between ~20 MiB/s and ~80+ MiB/s on localhost.
    ///
    /// `max_bytes` is the hard upper bound on stream size — uploads that
    /// exceed it abort with an error whose message starts with `Upload
    /// exceeds`. `ClipnestStorage::put` matches on that prefix to report
    /// the right FTP reply + user notification. Caller passes a sanity cap
    /// (e.g. 100 GiB to stop runaway clients from burning unbounded S3
    /// writes) — there is no plan-based gating here; quota enforcement
    /// runs post-upload via `claim_disk_space_and_tidy`.
    pub async fn put_object_stream(
        &self,
        key: &str,
        first_bytes: &[u8],
        reader: &mut (impl tokio::io::AsyncRead + Unpin + Send),
        user_salt: &str,
        max_bytes: i64,
    ) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);

        // Fill the first chunk buffer starting with already-read magic bytes
        let mut chunk: Vec<u8> = Vec::with_capacity(MULTIPART_CHUNK);
        chunk.extend_from_slice(first_bytes);

        let mut tmp = vec![0u8; READ_BUF];
        let mut total: i64 = first_bytes.len() as i64;

        // Read until we either fill the first chunk or hit EOF
        loop {
            if chunk.len() >= MULTIPART_CHUNK {
                break;
            }
            match read_or_idle(reader, &mut tmp).await {
                Ok(0) => {
                    // EOF (or idle timeout) — small file: single PUT
                    debug!(key = key, size = total, "put_object_stream: single PUT");
                    let bytes = Bytes::from(chunk);
                    let len = bytes.len() as i64;
                    if let Err(e) = timed(
                        S3Op::Put,
                        self.client
                            .put_object()
                            .bucket(&self.bucket)
                            .key(key)
                            .body(ByteStream::from(bytes))
                            .content_length(len)
                            .sse_customer_algorithm(algo)
                            .sse_customer_key(key_b64)
                            .sse_customer_key_md5(key_md5)
                            .send(),
                    )
                    .await
                    {
                        error!(error = %e, key = %key, layer = "s3_single_put_eof", "layer error");
                        return Err(Box::new(e));
                    }
                    return Ok(total);
                }
                Ok(n) => {
                    total += n as i64;
                    if total > max_bytes {
                        return Err(format!("Upload exceeds {max_bytes} byte limit").into());
                    }
                    chunk.extend_from_slice(&tmp[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // FTP TLS close without close_notify — treat as EOF
                    debug!(
                        key = key,
                        size = total,
                        "put_object_stream: TLS UnexpectedEof (normal)"
                    );
                    let bytes = Bytes::from(chunk);
                    let len = bytes.len() as i64;
                    if let Err(e) = timed(
                        S3Op::Put,
                        self.client
                            .put_object()
                            .bucket(&self.bucket)
                            .key(key)
                            .body(ByteStream::from(bytes))
                            .content_length(len)
                            .sse_customer_algorithm(algo.clone())
                            .sse_customer_key(key_b64.clone())
                            .sse_customer_key_md5(key_md5.clone())
                            .send(),
                    )
                    .await
                    {
                        error!(error = %e, key = %key, layer = "s3_single_put_unexpectedeof", "layer error");
                        return Err(Box::new(e));
                    }
                    return Ok(total);
                }
                Err(e) => {
                    error!(
                        error = %e,
                        kind = ?e.kind(),
                        key = %key,
                        layer = "ftps_data_read_first_chunk",
                        "layer error"
                    );
                    return Err(Box::new(e));
                }
            }
        }

        // Large file path — multipart upload
        info!(key = key, "put_object_stream: starting multipart upload");

        let mpu = match timed(
            S3Op::CreateMultipart,
            self.client
                .create_multipart_upload()
                .bucket(&self.bucket)
                .key(key)
                .sse_customer_algorithm(algo.clone())
                .sse_customer_key(key_b64.clone())
                .sse_customer_key_md5(key_md5.clone())
                .send(),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                error!(error = %e, key = %key, layer = "s3_create_multipart", "layer error");
                return Err(Box::new(e));
            }
        };
        let upload_id = mpu.upload_id().unwrap_or_default().to_string();

        let abort = |upload_id: String, key: String, client: S3Client, bucket: String| {
            let client = client.clone();
            tokio::spawn(async move {
                if let Err(e) = timed(
                    S3Op::AbortMultipart,
                    client
                        .abort_multipart_upload()
                        .bucket(bucket)
                        .key(key)
                        .upload_id(upload_id)
                        .send(),
                )
                .await
                {
                    warn!(error = %e, "Failed to abort multipart upload");
                }
            });
        };

        // Parallel multipart: spawn up to MULTIPART_CONCURRENCY part uploads
        // at once so S3 round-trips overlap with reading the next chunk.
        let mut joinset: tokio::task::JoinSet<
            Result<CompletedPart, Box<dyn std::error::Error + Send + Sync>>,
        > = tokio::task::JoinSet::new();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(MULTIPART_CONCURRENCY));
        let mut part_number: i32 = 1;

        // Queue part 1 (the already-full first chunk)
        queue_part(
            &mut joinset,
            sem.clone(),
            self.client.clone(),
            self.bucket.clone(),
            key.to_string(),
            upload_id.clone(),
            part_number,
            chunk,
            algo.clone(),
            key_b64.clone(),
            key_md5.clone(),
        )
        .await;
        part_number += 1;

        // Read remaining data and queue parts concurrently with uploads in flight
        loop {
            let mut next_chunk: Vec<u8> = Vec::with_capacity(MULTIPART_CHUNK);
            loop {
                if next_chunk.len() >= MULTIPART_CHUNK {
                    break;
                }
                match read_or_idle(reader, &mut tmp).await {
                    Ok(0) => break, // EOF or idle timeout (final part may be short)
                    Ok(n) => {
                        total += n as i64;
                        if total > max_bytes {
                            joinset.shutdown().await;
                            abort(
                                upload_id.clone(),
                                key.to_string(),
                                self.client.clone(),
                                self.bucket.clone(),
                            );
                            return Err(
                                format!("Upload exceeds {max_bytes} byte limit").into()
                            );
                        }
                        next_chunk.extend_from_slice(&tmp[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => {
                        error!(
                            error = %e,
                            kind = ?e.kind(),
                            key = %key,
                            bytes_read = total,
                            layer = "ftps_data_read_mid_stream",
                            "layer error"
                        );
                        joinset.shutdown().await;
                        abort(
                            upload_id.clone(),
                            key.to_string(),
                            self.client.clone(),
                            self.bucket.clone(),
                        );
                        return Err(Box::new(e));
                    }
                }
            }

            if next_chunk.is_empty() {
                break;
            }

            queue_part(
                &mut joinset,
                sem.clone(),
                self.client.clone(),
                self.bucket.clone(),
                key.to_string(),
                upload_id.clone(),
                part_number,
                next_chunk,
                algo.clone(),
                key_b64.clone(),
                key_md5.clone(),
            )
            .await;
            part_number += 1;
        }

        // Wait for every in-flight upload to finish, collecting parts.
        let mut parts: Vec<CompletedPart> = Vec::new();
        while let Some(joined) = joinset.join_next().await {
            match joined {
                Ok(Ok(p)) => parts.push(p),
                Ok(Err(e)) => {
                    error!(error = %e, key = %key, layer = "s3_upload_part", "layer error");
                    joinset.shutdown().await;
                    abort(
                        upload_id.clone(),
                        key.to_string(),
                        self.client.clone(),
                        self.bucket.clone(),
                    );
                    return Err(e);
                }
                Err(e) => {
                    joinset.shutdown().await;
                    abort(
                        upload_id.clone(),
                        key.to_string(),
                        self.client.clone(),
                        self.bucket.clone(),
                    );
                    return Err(Box::new(e));
                }
            }
        }
        // S3 CompleteMultipartUpload requires parts in ascending part_number order.
        parts.sort_by_key(|p| p.part_number().unwrap_or(0));

        // Complete multipart upload — also gated so a burst of finalising
        // uploads doesn't itself reopen N fresh TLS connections to the object store.
        let completed = CompletedMultipartUpload::builder()
            .set_parts(Some(parts))
            .build();

        // Retry the finalise, then verify before giving up.
        //
        // This call used to be single-shot, which made a momentary S3 hiccup
        // discard an upload that had already streamed in full — the worst
        // possible moment to fail. A long upload could die here on a
        // `service error` while a HEAD afterwards showed the object HAD been
        // created: the object store had completed it and only the response
        // came back an error, so the bytes sat in the bucket as an
        // unregistered orphan the reconciler would eventually purge.
        //
        // CompleteMultipartUpload is idempotent for the same parts, so
        // retrying is safe. The final HEAD covers the observed case where the
        // operation succeeded but we never saw the confirmation.
        let mut last_err = None;
        for (attempt, backoff_ms) in [0u64, 300, 1200].into_iter().enumerate() {
            if backoff_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
            match timed(
                S3Op::CompleteMultipart,
                self.client
                    .complete_multipart_upload()
                    .bucket(&self.bucket)
                    .key(key)
                    .upload_id(&upload_id)
                    .multipart_upload(completed.clone())
                    .sse_customer_algorithm(algo.clone())
                    .sse_customer_key(key_b64.clone())
                    .sse_customer_key_md5(key_md5.clone())
                    .send(),
            )
            .await
            {
                Ok(_) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    warn!(
                        error = %e, key = %key, attempt = attempt + 1,
                        "complete_multipart_upload failed — retrying"
                    );
                    last_err = Some(e);
                }
            }
        }
        if let Some(e) = last_err {
            // Every attempt reported failure. Before throwing the upload away,
            // ask S3 whether the object exists anyway.
            // Same rule as the metadata path: a 404 here is S3 answering
            // "that object does not exist" — bad news for this upload, but not
            // an S3 fault, and the upload failure is surfaced on its own.
            match timed_where(
                S3Op::Head,
                head_object_failed,
                self.client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .sse_customer_algorithm(algo)
                    .sse_customer_key(key_b64)
                    .sse_customer_key_md5(key_md5)
                    .send(),
            )
            .await
            {
                Ok(head) if head.content_length().unwrap_or(0) > 0 => {
                    warn!(
                        key = %key,
                        size = head.content_length().unwrap_or(0),
                        "complete_multipart_upload reported failure but the object exists — treating as complete"
                    );
                }
                _ => {
                    error!(error = %e, key = %key, layer = "s3_complete_multipart", "layer error");
                    return Err(Box::new(e));
                }
            }
        }

        info!(
            key = key,
            total_bytes = total,
            parts = part_number - 1,
            "put_object_stream: multipart upload complete"
        );
        Ok(total)
    }

    pub async fn get_object(
        &self,
        key: &str,
        user_salt: &str,
    ) -> Result<(ByteStream, Option<i64>), aws_sdk_s3::Error> {
        debug!(key = key, "Downloading from S3");

        let mut req = self.client.get_object().bucket(&self.bucket).key(key);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        let resp = timed(S3Op::Get, req.send()).await?;

        Ok((resp.body, resp.content_length))
    }

    pub async fn head_object(&self, key: &str, user_salt: &str) -> Result<i64, aws_sdk_s3::Error> {
        Ok(self.head_object_full(key, user_salt).await?.0)
    }

    /// Like `head_object` but also returns LastModified — used by the FTPS
    /// metadata path so MLSD/LIST shows the upload time, not "now".
    pub async fn head_object_full(
        &self,
        key: &str,
        user_salt: &str,
    ) -> Result<(i64, Option<std::time::SystemTime>), aws_sdk_s3::Error> {
        let mut req = self.client.head_object().bucket(&self.bucket).key(key);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        let resp = timed_where(S3Op::Head, head_object_failed, req.send()).await?;
        let modified = resp
            .last_modified
            .as_ref()
            .and_then(|t| std::time::SystemTime::try_from(*t).ok());

        Ok((resp.content_length.unwrap_or(0), modified))
    }

    /// Server-side copy of an encrypted object to a new key under the same bucket.
    ///
    /// Used by FTPS `rename` (see `storage.rs::rename`). Passing the user's salt
    /// on both the SSE-C (source) and SSE-C (destination) headers lets MinIO
    /// re-encrypt the object without the data ever round-tripping through the
    /// FTPS process. This replaces the previous `get_object → read_to_end →
    /// put_object` pattern, which was an unbounded-RAM DoS vector: each
    /// concurrent rename buffered the entire source file in RAM.
    pub async fn copy_object(
        &self,
        from_key: &str,
        to_key: &str,
        user_salt: &str,
    ) -> Result<(), aws_sdk_s3::Error> {
        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);

        // aws-sdk-s3 expects `copy_source` as `<bucket>/<urlencoded key>`. Keys
        // we generate contain only [A-Za-z0-9_./-] (UUID + date + camera name
        // from a whitelisted regex), so a plain concat is safe — no spaces,
        // no `+`, no unicode. If that ever changes, switch to percent-encoding.
        let copy_source = format!("{}/{}", self.bucket, from_key);

        let req = self
            .client
            .copy_object()
            .bucket(&self.bucket)
            .key(to_key)
            .copy_source(copy_source)
            // SSE-C headers apply to the destination write
            .sse_customer_algorithm(&algo)
            .sse_customer_key(&key_b64)
            .sse_customer_key_md5(&key_md5)
            // Matching SSE-C headers on the source read (same per-user key)
            .copy_source_sse_customer_algorithm(&algo)
            .copy_source_sse_customer_key(&key_b64)
            .copy_source_sse_customer_key_md5(&key_md5);

        timed(S3Op::Copy, req.send()).await?;

        Ok(())
    }

    pub async fn delete_object(&self, key: &str) -> Result<(), aws_sdk_s3::Error> {
        debug!(key = key, "Deleting from S3");

        timed(
            S3Op::Delete,
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(key)
                .send(),
        )
        .await?;

        Ok(())
    }

    /// Batch delete. S3 `DeleteObjects` takes up to 1000 keys per request, so
    /// for N files this issues ⌈N/1000⌉ round-trips instead of N. On a dir
    /// with 500 uploads that's the difference between ~500 HTTP calls
    /// (minutes on anything with latency) and 1 call (sub-second).
    pub async fn delete_objects(&self, keys: &[String]) -> Result<(), aws_sdk_s3::Error> {
        use aws_sdk_s3::types::{Delete, ObjectIdentifier};
        const BATCH: usize = 1000;
        for chunk in keys.chunks(BATCH) {
            let objects: Vec<ObjectIdentifier> = chunk
                .iter()
                .map(|k| {
                    ObjectIdentifier::builder()
                        .key(k)
                        .build()
                        .expect("key is non-empty")
                })
                .collect();
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .expect("Delete.objects set above");
            timed(
                S3Op::DeleteBatch,
                self.client
                    .delete_objects()
                    .bucket(&self.bucket)
                    .delete(delete)
                    .send(),
            )
            .await?;
        }
        Ok(())
    }

    /// Does anything exist under `prefix`? One page, one key, one S3 call.
    ///
    /// WHY THIS IS NOT `list_objects(..).is_empty()`. `cwd` and `metadata` only
    /// ever need this boolean, but they used to get it from the fully paginated
    /// helper below — so proving a directory exists cost O(every page) of the
    /// slowest S3 verb, on the hottest path the FTPS server has. That is what
    /// destroyed recordings once the object store degraded (`list` at several
    /// seconds, `put` at tens of seconds): every camera `CWD 2026` -> `CWD 09` ->
    /// `CWD 09` rode it, and the cameras hung up before ever issuing STOR. The
    /// loss was invisible because a camera that dies BEFORE STOR never reaches
    /// `salvage_upload`, so nothing counted it.
    ///
    /// `max_keys(1)` plus no continuation loop makes the cost independent of
    /// how many objects the prefix holds — even a prefix holding nine objects
    /// was slow.
    pub async fn prefix_exists(&self, prefix: &str, budget: std::time::Duration) -> Probe {
        let req = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .max_keys(1);

        match timed_within_on(global(), S3Op::ListProbe, budget, |_| true, req.send()).await {
            Some(Ok(resp)) => {
                if resp.contents().is_empty() {
                    Probe::Absent
                } else {
                    Probe::Present
                }
            }
            Some(Err(e)) => {
                warn!(error = %e, prefix = %prefix, "prefix_exists: S3 list failed");
                Probe::Unknown
            }
            None => {
                warn!(
                    prefix = %prefix,
                    budget_ms = budget.as_millis() as u64,
                    "prefix_exists: S3 did not answer inside the budget"
                );
                Probe::Unknown
            }
        }
    }

    /// Is there a directory-marker object at `dir_key` (a trailing-slash key)?
    ///
    /// `mkd` writes one of these as a zero-byte object, so for any directory a
    /// camera created with MKD this single cheap HeadObject answers the
    /// existence question outright — no listing at all. HEAD is also the verb
    /// that holds up best when the object store degrades: in one such event `head`
    /// was 0.005 s while `list` was 5.8 s.
    ///
    /// A 404 is `Absent`, not an error — see `head_object_failed`.
    pub async fn dir_marker_exists(
        &self,
        dir_key: &str,
        user_salt: &str,
        budget: std::time::Duration,
    ) -> Probe {
        let mut req = self.client.head_object().bucket(&self.bucket).key(dir_key);

        let (algo, key_b64, key_md5) = self.get_ssec(user_salt);
        req = req
            .sse_customer_algorithm(algo)
            .sse_customer_key(key_b64)
            .sse_customer_key_md5(key_md5);

        match timed_within_on(global(), S3Op::Head, budget, head_object_failed, req.send()).await {
            Some(Ok(_)) => Probe::Present,
            Some(Err(e)) => {
                if head_object_failed(&e) {
                    warn!(error = %e, key = %dir_key, "dir_marker_exists: S3 head failed");
                    Probe::Unknown
                } else {
                    Probe::Absent
                }
            }
            None => {
                warn!(
                    key = %dir_key,
                    budget_ms = budget.as_millis() as u64,
                    "dir_marker_exists: S3 did not answer inside the budget"
                );
                Probe::Unknown
            }
        }
    }

    pub async fn list_objects(&self, prefix: &str) -> Result<Vec<S3Object>, aws_sdk_s3::Error> {
        let mut results = Vec::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);

            if let Some(token) = &continuation_token {
                req = req.continuation_token(token);
            }

            let resp = timed(S3Op::List, req.send()).await?;

            for obj in resp.contents() {
                if let Some(key) = obj.key.as_deref() {
                    results.push(S3Object {
                        key: key.to_string(),
                        size: obj.size.unwrap_or(0),
                        last_modified: obj
                            .last_modified
                            .as_ref()
                            .and_then(|t| std::time::SystemTime::try_from(*t).ok()),
                    });
                }
            }

            if resp.is_truncated.unwrap_or(false) {
                continuation_token = resp.next_continuation_token.clone();
            } else {
                break;
            }
        }

        Ok(results)
    }
}

/// One `reader.read`, bounded by `READ_IDLE_TIMEOUT`. A timeout reports `Ok(0)`
/// — the same shape as EOF — so both streaming loops finalise with the bytes
/// they already hold instead of hanging on a socket that will never deliver.
async fn read_or_idle(
    reader: &mut (impl tokio::io::AsyncRead + Unpin + Send),
    buf: &mut [u8],
) -> std::io::Result<usize> {
    match tokio::time::timeout(READ_IDLE_TIMEOUT, reader.read(buf)).await {
        Ok(res) => res,
        Err(_) => {
            warn!(
                idle_secs = READ_IDLE_TIMEOUT.as_secs(),
                "Upload stalled with no bytes — treating as end of stream"
            );
            Ok(0)
        }
    }
}

/// Spawn one `upload_part` call into the JoinSet, gated by a per-file
/// semaphore (MULTIPART_CONCURRENCY permits). The acquire happens before
/// spawning so the read loop naturally throttles when N parts are already
/// uploading for this file.
#[allow(clippy::too_many_arguments)]
async fn queue_part(
    joinset: &mut tokio::task::JoinSet<
        Result<CompletedPart, Box<dyn std::error::Error + Send + Sync>>,
    >,
    sem: std::sync::Arc<tokio::sync::Semaphore>,
    client: S3Client,
    bucket: String,
    key: String,
    upload_id: String,
    part_number: i32,
    data: Vec<u8>,
    algo: String,
    key_b64: String,
    key_md5: String,
) {
    let permit = sem.acquire_owned().await.expect("semaphore closed");
    joinset.spawn(async move {
        let _p = permit; // released when the task ends
        let bytes = Bytes::from(data);
        let len = bytes.len() as i64;
        let resp = timed(
            S3Op::UploadPart,
            client
                .upload_part()
                .bucket(bucket)
                .key(key)
                .upload_id(upload_id)
                .part_number(part_number)
                .body(ByteStream::from(bytes))
                .content_length(len)
                .sse_customer_algorithm(algo)
                .sse_customer_key(key_b64)
                .sse_customer_key_md5(key_md5)
                .send(),
        )
        .await?;
        Ok(CompletedPart::builder()
            .part_number(part_number)
            .set_e_tag(resp.e_tag.clone())
            .build())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    ///story: Debug-format `S3` nigdy nie ujawnia `master_key` — to root sekret szyfrowania (IKM dla HKDF każdego klucza SSE-C). `S3` siedzi w `ClipnestStorage`, którą libunftp Debug-uje na sesyjnym instrumencie; `#[derive(Debug)]` wypisałby master key plaintextem do journald.
    #[test]
    fn debug_format_redacts_master_key() {
        let conf = S3ConfigBuilder::new()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .build();
        let client = S3Client::from_conf(conf);
        let s3 = S3 {
            client,
            bucket: "clipnest-recordings".to_string(),
            master_key: "SUPER_SECRET_MASTER_KEY_VALUE".to_string(),
        };

        let dbg = format!("{:?}", s3);

        assert!(
            !dbg.contains("SUPER_SECRET_MASTER_KEY_VALUE"),
            "S3 Debug leaked the encryption master_key: {}",
            dbg,
        );
        assert!(
            dbg.contains("<redacted>"),
            "S3 Debug must mark the redaction: {}",
            dbg,
        );
        assert!(
            dbg.contains("clipnest-recordings"),
            "S3 Debug should keep the (non-secret) bucket for ops: {}",
            dbg,
        );
    }

    // --- S3 latency instrumentation -------------------------------------
    //
    // These assert against the PROCESS-WIDE registry (`metrics::global()`),
    // because that is what production writes to and the point of the test is
    // that the real call sites are wired up. They therefore compare a
    // before/after delta rather than an absolute count, so they stay correct
    // no matter what else the test binary is doing concurrently.

    const LIST_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents><Key>p/one.mp4</Key><Size>17</Size></Contents>
</ListBucketResult>"#;

    fn s3_against(uri: String) -> S3 {
        let conf = S3ConfigBuilder::new()
            .behavior_version_latest()
            .region(Region::new("us-east-1"))
            .endpoint_url(uri)
            .force_path_style(true)
            .credentials_provider(Credentials::new("ak", "sk", None, None, "test"))
            .retry_config(RetryConfig::disabled())
            // `default-features = false` on aws-sdk-s3 means there is no
            // implicit HTTP client — the same pinned rustls connector
            // production uses has to be attached here too, or every request
            // fails with "No HTTP client was available" before it leaves the
            // process (and the test would then be measuring nothing).
            .http_client(
                HttpClientBuilder::new()
                    .tls_provider(tls::Provider::Rustls(tls::rustls_provider::CryptoMode::AwsLc))
                    .build_https(),
            )
            .build();
        S3 {
            client: S3Client::from_conf(conf),
            bucket: "b".to_string(),
            master_key: "0".repeat(64),
        }
    }

    /// Sample of a `clipnest_ftps_*` series from the global registry.
    fn sample(needle: &str) -> u64 {
        crate::metrics::global()
            .render()
            .lines()
            .find(|l| l.starts_with(needle))
            .and_then(|l| l.rsplit(' ').next().map(|v| v.to_string()))
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v as u64)
            .unwrap_or(0)
    }

    ///story: Metryki są warte tyle, ile wiernie odwzorowują prawdziwe wywołania — histogram, który nikt nie podpiął do call site'u, renderuje idealne zera i wygląda na zdrową produkcję. Ten test dowodzi, że `list_objects` naprawdę zasila serię `op="list"`.
    #[tokio::test]
    async fn list_objects_is_instrumented() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(LIST_XML, "application/xml"))
            .mount(&server)
            .await;

        let before = sample("clipnest_ftps_s3_request_duration_seconds_count{op=\"list\"}");
        let objects = s3_against(server.uri()).list_objects("p/").await.unwrap();

        assert_eq!(objects.len(), 1);
        assert_eq!(
            sample("clipnest_ftps_s3_request_duration_seconds_count{op=\"list\"}"),
            before + 1,
        );
    }

    ///story: Nieudane wywołanie S3 musi podbić licznik błędów przy PRAWDZIWYM call site, nie tylko w teście jednostkowym opakowania — bez tego wskaźnik błędów zostaje na zerze w trakcie awarii, dokładnie wtedy, gdy jedyny ślad po zerwanym uploadzie kamery jest w logu. Ale HEAD zwracający 404 to NIE awaria: `storage.rs::metadata` sonduje klucz i przy braku odpowiedzi cofa się do markera katalogu, więc brak obiektu to zwykły przepływ sterowania. Liczenie go jako błędu S3 dawało ~50% "błędów" na op="head" i z czasem odpaliłoby FtpsS3ErrorsSustained z komunikatem "recordings are being lost", gdy nic się nie dzieje.
    ///
    /// Oba przypadki żyją w JEDNYM teście, bo dzielą globalny rejestr metryk: osobne testy czytające `clipnest_ftps_s3_errors_total{op="head"}` ścigałyby się ze sobą przy równoległym uruchomieniu i asercje `before + 1` byłyby flaky.
    #[tokio::test]
    async fn head_counts_failures_but_not_missing_keys() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        // A 500 is a genuine S3 failure — it must be counted.
        let broken = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&broken)
            .await;

        let errors_before = sample("clipnest_ftps_s3_errors_total{op=\"head\"}");
        let res = s3_against(broken.uri()).head_object("k", "salt").await;

        assert!(res.is_err(), "a 500 from S3 must surface as an error");
        assert_eq!(
            sample("clipnest_ftps_s3_errors_total{op=\"head\"}"),
            errors_before + 1,
            "a 500 is an S3 failure and must be counted",
        );

        // A 404 is an answer, not a failure.
        let empty = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&empty)
            .await;

        let errors_before = sample("clipnest_ftps_s3_errors_total{op=\"head\"}");
        let observed_before =
            sample("clipnest_ftps_s3_request_duration_seconds_count{op=\"head\"}");
        let res = s3_against(empty.uri()).head_object("k", "salt").await;

        assert!(
            res.is_err(),
            "a missing key still surfaces as Err to the caller — only the metric changes"
        );
        assert_eq!(
            sample("clipnest_ftps_s3_errors_total{op=\"head\"}"),
            errors_before,
            "a 404 is a normal answer and must NOT count as an S3 error",
        );
        assert_eq!(
            sample("clipnest_ftps_s3_request_duration_seconds_count{op=\"head\"}"),
            observed_before + 1,
            "the duration of a 404 is still S3 latency and must still be observed",
        );

        // --- the same 404-vs-500 split, as `dir_marker_exists` reports it ---
        //
        // This lives HERE rather than in its own test for the reason given
        // above: `dir_marker_exists` is a HeadObject, so a separate test would
        // perturb the `op="head"` deltas this one asserts. (It did exactly that
        // when first written, which is how the hazard documented above got
        // confirmed a second time.)
        //
        // `cwd` depends on this distinction in both directions: `Absent` is
        // what lets it refuse a nonexistent directory with 550, and `Unknown`
        // is what makes it admit the client optimistically instead of turning
        // a broken S3 into a fabricated "no such directory".
        let present = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(200).append_header("content-length", "0"))
            .mount(&present)
            .await;
        assert_eq!(
            s3_against(present.uri())
                .dir_marker_exists("p/", "salt", std::time::Duration::from_secs(30))
                .await,
            Probe::Present,
        );

        assert_eq!(
            s3_against(empty.uri())
                .dir_marker_exists("p/", "salt", std::time::Duration::from_secs(30))
                .await,
            Probe::Absent,
            "a 404 means the marker is not there — an answer, not a fault",
        );

        assert_eq!(
            s3_against(broken.uri())
                .dir_marker_exists("p/", "salt", std::time::Duration::from_secs(30))
                .await,
            Probe::Unknown,
            "a 500 tells us nothing about whether the directory exists",
        );
    }

    const TRUNCATED_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>1</KeyCount>
  <MaxKeys>1</MaxKeys><IsTruncated>true</IsTruncated>
  <NextContinuationToken>MORE</NextContinuationToken>
  <Contents><Key>p/one.mp4</Key><Size>17</Size></Contents>
</ListBucketResult>"#;

    ///story: `cwd`/`metadata` potrzebują tylko odpowiedzi "czy cokolwiek tu jest", a brały ją z w pełni paginowanego `list_objects` — więc sprawdzenie istnienia katalogu kosztowało O(wszystkie strony) najwolniejszego czasownika S3, na najgorętszej ścieżce serwera. Gdy magazyn obiektów wystawia `list` na kilka sekund, kamery umierają na CWD przed STOR i tracą nagrania. Sonda MUSI zostać na jednej stronie nawet gdy S3 mówi `IsTruncated: true`, bo inaczej wracamy dokładnie do tego kosztu.
    #[tokio::test]
    async fn prefix_probe_asks_for_one_key_and_never_paginates() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(TRUNCATED_XML, "application/xml"))
            .mount(&server)
            .await;

        let verdict = s3_against(server.uri())
            .prefix_exists("p/", std::time::Duration::from_secs(30))
            .await;

        assert_eq!(verdict, Probe::Present);

        let reqs = server.received_requests().await.expect("recorded requests");
        assert_eq!(
            reqs.len(),
            1,
            "the probe followed the continuation token — that is the unbounded cost coming back",
        );
        let query = reqs[0].url.query().unwrap_or_default().to_string();
        assert!(
            query.contains("max-keys=1"),
            "the probe must cap the page at one key, got query {query:?}",
        );
    }

    ///story: Pusty prefiks musi dać jednoznaczne `Absent`, nie `Unknown` — bez tego `cwd` nigdy nie odmówi wejścia do nieistniejącego katalogu i 550 przestaje działać.
    #[tokio::test]
    async fn empty_prefix_is_absent_not_unknown() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const EMPTY_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>0</KeyCount>
  <MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated>
</ListBucketResult>"#;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(EMPTY_XML, "application/xml"))
            .mount(&server)
            .await;

        let verdict = s3_against(server.uri())
            .prefix_exists("p/", std::time::Duration::from_secs(30))
            .await;

        assert_eq!(verdict, Probe::Absent);
    }

    ///story: To jest regresja na utratę nagrań. Wolny S3 nie może trzymać kanału kontrolnego kamery — po budżecie sonda ma zwrócić `Unknown` i oddać sterowanie, a nie wisieć. Dodatkowo przekroczony budżet musi zostawić ślad w `clipnest_ftps_dir_probe_timeouts_total`, bo inaczej dokładnie ta awaria znowu będzie niewidoczna.
    #[tokio::test]
    async fn probe_past_its_budget_returns_unknown_and_is_counted() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(LIST_XML, "application/xml")
                    .set_delay(std::time::Duration::from_secs(30)),
            )
            .mount(&server)
            .await;

        let timeouts_before = sample("clipnest_ftps_dir_probe_timeouts_total");
        let started = std::time::Instant::now();

        let verdict = s3_against(server.uri())
            .prefix_exists("p/", std::time::Duration::from_millis(150))
            .await;

        assert_eq!(verdict, Probe::Unknown);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the probe outlived its budget by {:?} — a camera would have hung up",
            started.elapsed(),
        );
        assert_eq!(
            sample("clipnest_ftps_dir_probe_timeouts_total"),
            timeouts_before + 1,
            "an unanswered probe must be counted, or this outage is invisible again",
        );
    }
}
