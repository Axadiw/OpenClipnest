import { CONFIG } from '../config.js';
import { removeDeletedFileFromEvents, removeFileMetadata } from '../db/queries/events.js';
import { getUserInternalIdByUuid } from '../db/queries/users.js';
import { deleteNotificationsForEvent } from '../db/queries/notifications.js';
import { deleteGeneratedThumbnail } from './eventCleanup.js';
import { deleteSidecarsForRecording } from './fileLifecycle.js';
import { parseS3KeyForDelete } from './ingest/filenameParse.js';
import { getCachedUserInternalId } from './userIdCache.js';
import { recordEventsDeleted, originFor } from '../utils/metrics.js';

export interface DeleteNotify {
  userUuid: string;
  s3Key: string;
}

export async function handleDeleteNotify({ userUuid, s3Key }: DeleteNotify): Promise<void> {
  // Unconditional file_metadata cleanup MUST precede every early-return.
  // Since v0.10.277 (PR #217 "feat(ftps): accept all file types") FTPS PUT
  // inserts a file_metadata row for any extension (the /file-uploaded
  // handler doesn't filter), but parseS3KeyForDelete below only succeeds
  // for the canonical video-recording filename pattern. Without this
  // up-front cleanup, non-video DELE (snapshot .jpg, config .txt) left
  // file_metadata rows behind → the reconciler-Step-2c safety net then
  // chased them every tick, firing Sentry warn-spam.
  // Owner-scope safe: file_metadata UNIQUE (s3_bucket, s3_key) pins each
  // row to one user, so DELETE-by-key cannot cross tenants.
  // Run parallel with the event-row mutation when the parse succeeds.
  const fileMetaCleanup = removeFileMetadata(CONFIG.s3RecordingsBucket, s3Key).catch(err => {
    console.warn(
      `event-manager: file_metadata cleanup failed for ${s3Key}:`,
      err instanceof Error ? err.message : String(err),
    );
  });

  const parsed = parseS3KeyForDelete(s3Key);
  if (!parsed) {
    // Non-recording extension (.txt/.jpg/.json/…) — file_metadata cleaned
    // above; nothing else to do since there is no eventId to mutate. Silent
    // `console.log` keeps Sentry (captureConsole at warn+) clean.
    console.log(`event-manager: cannot parse s3Key=${s3Key} (non-recording extension), file_metadata cleaned`);
    await fileMetaCleanup;
    return;
  }

  // It IS a recording → delete its per-FILE sidecars (.fmp4patch / .clean_frame
  // / .classic_moov / .frames / …) from the sidecars bucket. Sidecars are keyed
  // off this exact recording key, so this is independent of the event mutation
  // and of owner/uuid resolution — we clean them even on a userUuid mismatch or
  // an unknown owner. Before this, FTPS DELE removed the recording + DB rows but
  // left every sidecar behind (the 217k-object leak). Prefix-based so all
  // suffixes are covered. Best-effort: a failure must not block the delete.
  const sidecarCleanup = deleteSidecarsForRecording(s3Key).catch(err => {
    console.warn(
      `event-manager: sidecar cleanup failed for ${s3Key}:`,
      err instanceof Error ? err.message : String(err),
    );
  });

  if (parsed.userUuid !== userUuid) {
    console.warn(
      `event-manager: userUuid mismatch in delete/notify — payload=${userUuid} key=${parsed.userUuid}, skipping event mutation`,
    );
    await Promise.all([fileMetaCleanup, sidecarCleanup]);
    return;
  }

  // Resolve userUuid → internal id (FK for owner-scoped writes). Cached
  // per-process: the mapping is immutable (SERIAL PK + soft-delete only),
  // so the first lookup warms a 5min TTL and subsequent messages for the
  // same user hit memory. Lightweight `SELECT id` query on miss, not the
  // heavy USER_SELECT join used by auth/account paths.
  const ownerId = await getCachedUserInternalId(userUuid, getUserInternalIdByUuid);
  if (ownerId === null) {
    console.warn(`event-manager: unknown userUuid=${userUuid} in delete-notify, skipping event mutation`);
    await Promise.all([fileMetaCleanup, sidecarCleanup]);
    return;
  }

  try {
    // The DB stores user-relative view paths (`{date}/Cam_VV_ts.mp4`); FTPS
    // publishes the FULL key on stream:delete-notify. Strip the `{userUuid}/`
    // prefix to match `event_view_files.video_rel_path`.
    const userPrefix = `${userUuid}/`;
    const relKey = s3Key.startsWith(userPrefix) ? s3Key.slice(userPrefix.length) : s3Key;

    // Locate the event by the file's ACTUAL elf linkage (video_rel_path) and
    // delete it once no views remain. We deliberately do NOT use
    // parseS3KeyForDelete's filename-derived eventId here: a proximity-merged
    // dual-view event keeps the EARLIER view's tsRaw as its id, so the later
    // view's file lives on an event whose id ≠ the id derived from that file's
    // own name. The old derive-then-target path no-op'd on the merged view and
    // orphaned the row (0 B + a residual event in the UI). See
    // removeDeletedFileFromEvents.
    const { deletedEventIds } = await removeDeletedFileFromEvents(ownerId, relKey);

    // Runs in the thumbnail-worker, not the API — see the scrape caveat in
    // utils/metrics.ts. The worker's /healthz server exposes /metrics for
    // exactly this reason: without it, every recording removed straight from
    // FTPS or the bucket would be invisible on the activity dashboard.
    recordEventsDeleted('file_removed', originFor(userUuid), deletedEventIds.length);

    // Best-effort cleanup per actually-deleted event (generated thumbnail
    // object + notifications). Owner-scoped, so cross-tenant leakage is
    // structurally impossible.
    for (const evId of deletedEventIds) {
      await Promise.all([
        deleteGeneratedThumbnail(evId, userUuid),
        deleteNotificationsForEvent(evId).catch(() => { /* non-fatal */ }),
      ]);
    }
    if (deletedEventIds.length > 0) {
      console.log(
        `event-manager: delete-notify ${s3Key} → deleted ${deletedEventIds.length} event(s) with no files left`,
      );
    }

    await Promise.all([fileMetaCleanup, sidecarCleanup]);
  } catch (err) {
    console.error(
      `event-manager: delete handler error for ${s3Key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
