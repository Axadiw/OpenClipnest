/**
 * Auto-delete oldest **uploads** (true FTPS-upload-time FIFO) to free disk for
 * a quota-pressed user. Replaces the previous event-timestamp ordering, which
 * broke when the user uploaded non-event files (junk, malformed naming, raw
 * sidecars) — those would never be evicted because they had no event row.
 *
 * Walks `file_metadata` ordered by `uploaded_at ASC`. For each file:
 *   1. Delete the S3 object.
 *   2. Cascade to any events referencing the object via `wide_video` /
 *      `zoom_video` / `thumbnail` columns: null the matching column;
 *      if the event ends up with no surviving wide/zoom video, remove the
 *      row + its generated `__generated__/{eventId}.jpg` thumbnail.
 *   3. Drop the `file_metadata` row.
 *   4. Decrement `disk_usage_bytes`.
 *
 * Triggered by the FTPS server's pre-upload quota check and by the new
 * post-upload claim-or-evict retry, both gated on the user's
 * `auto_delete_oldest` flag. The retention service (Phase C) reuses the
 * per-file cascade via `evictFile`.
 */
import {
  getOldestFileForUser,
  findEventsReferencingS3Key,
  updateEventFiles,
  type FileMetaRow,
} from '../db/queries/events.js';
import { getAutoDeleteOldest } from '../db/queries/storage.js';
import type { CameraEvent } from '../types.js';
import { deleteObject } from './s3.js';
import { deleteEventAndThumbnail } from './eventCleanup.js';
import { deleteS3AndMetadata } from './fileLifecycle.js';
import { CONFIG } from '../config.js';

export interface DeleteVideoTarget {
  userUuid: string;
  s3Bucket: string;
  s3Key: string;
}

/**
 * Per-clip S3 delete: drops the original mp4 + the matching fmp4 patch
 * sidecar from the sidecars bucket. Idempotent on double-call — both inner
 * deletes absorb 404s.
 */
export async function deleteUserVideoObject(target: DeleteVideoTarget): Promise<void> {
  await deleteObject(target.s3Bucket || CONFIG.s3RecordingsBucket, target.s3Key);
  // Sidecar lifecycle: every original-mp4 delete must also drop its fmp4
  // patch sidecar from the dedicated bucket. Best-effort — a missing sidecar
  // is normal (worker may not have run yet, file may have been class B/C),
  // and the periodic reconciler sweep catches anything that slipped through.
  await deleteSidecarBestEffort(target.s3Key);
}

async function deleteSidecarBestEffort(s3Key: string): Promise<void> {
  const sidecarKey = `${s3Key}.fmp4patch`;
  try {
    await deleteObject(CONFIG.s3SidecarsBucket, sidecarKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/NotFound|NoSuchKey/i.test(msg)) {
      console.warn(
        `deleteUserVideoObject: sidecar delete failed for ${sidecarKey}: ${msg}`,
      );
    }
  }
}

export interface AutoDeleteResult {
  deleted: number;
  freedBytes: number;
  enabled: boolean;
}

// Per-call deletion / fraction-of-library caps were removed 2026-04-29
// (user feedback): they were defensive measures against a buggy caller
// passing Number.MAX_SAFE_INTEGER as targetBytes, but the caller-side
// signal (`auto_delete_oldest = true`) is itself the user's explicit
// opt-in, and the cost of capping legitimate big-file uploads was higher
// than the cost of trusting the caller. The natural ceiling now is
// `targetBytes` itself (loop terminates when met) or library exhaustion
// (no more rows in `file_metadata`). The caller (FTPS / retention cron)
// is responsible for picking a sensible target.

/**
 * Evict a single file: atomic S3+DB+disk_usage delete via deleteS3AndMetadata
 * helper → sidecar best-effort cleanup → event cascade. Returns bytes freed
 * (0 when the atomic delete failed — orphan or transient state to be retried
 * by reconciler). Reused by both the near-limit auto-delete loop and the
 * retention service (Phase C).
 *
 * Previously this function manually orchestrated S3 → DB → disk_usage with
 * separate try/catch per step. That allowed two bug modes that produced
 * `[reconciler] orphan_file_metadata_detected` bursts in Sentry: if the DB
 * row delete threw transiently, S3 was already gone (orphan), AND
 * disk_usage was still decremented (counter skew). The helper enforces
 * S3-first → DB → disk_usage atomicity: skew is impossible, and orphans
 * are limited to the S3-first window (reconciler safety-net catches them).
 */
export async function evictFile(
  file: FileMetaRow,
  userId: number,
  userUuid: string,
  // Both eviction policies funnel through here, and they are different things
  // to an operator reading the activity dashboard: `quota` means the user ran
  // out of space, `retention` means their own age rule fired.
  reason: 'quota' | 'retention',
): Promise<number> {
  let refs: CameraEvent[] = [];
  try {
    refs = await findEventsReferencingS3Key(userId, file.s3Key, userUuid);
  } catch (err) {
    console.warn(
      `evictFile: event-ref lookup failed for ${file.s3Key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  let metadataDeleted: boolean;
  try {
    const result = await deleteS3AndMetadata({
      ownerId: userId,
      s3Bucket: file.s3Bucket,
      s3Key: file.s3Key,
      reason: 'auto-delete-evict',
    });
    metadataDeleted = result.metadataDeleted;
  } catch (err) {
    console.warn(
      `evictFile: deleteS3AndMetadata failed for ${file.s3Key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }

  await deleteSidecarBestEffort(file.s3Key);

  const prefix = `${userUuid}/`;
  const rel = file.s3Key.startsWith(prefix) ? file.s3Key.slice(prefix.length) : file.s3Key;

  for (const ev of refs) {
    // After removing every view-file row that points at `rel`, would the
    // event have any view left? Use the in-memory snapshot so this matches
    // the contract `updateEventFiles` will execute server-side.
    const remainingViews = ev.views.filter(l => l.videoRelPath !== rel);

    if (remainingViews.length === 0) {
      try {
        await deleteEventAndThumbnail(ev.id, userId, userUuid, reason);
      } catch (err) {
        console.warn(
          `evictFile: deleteEventAndThumbnail failed for ${ev.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      try {
        await updateEventFiles(ev.id, userId, rel);
      } catch (err) {
        console.warn(
          `evictFile: updateEventFiles failed for ${ev.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return metadataDeleted ? file.fileSizeBytes : 0;
}

export async function autoDeleteOldestUntilFreed(
  userId: number,
  userUuid: string,
  _encryptionSalt: string,
  targetBytes: number,
): Promise<AutoDeleteResult> {
  if (targetBytes <= 0) return { deleted: 0, freedBytes: 0, enabled: false };
  if (!(await getAutoDeleteOldest(userId))) {
    return { deleted: 0, freedBytes: 0, enabled: false };
  }

  let deleted = 0;
  let freedBytes = 0;

  while (freedBytes < targetBytes) {
    const file = await getOldestFileForUser(userId);
    if (!file) break;            // library empty — natural termination
    freedBytes += await evictFile(file, userId, userUuid, 'quota');
    deleted++;
  }

  // Notification creation moved to Phase D — auto-delete is now silent so the
  // user's notification feed isn't flooded by routine eviction.

  return { deleted, freedBytes, enabled: true };
}
