import { deleteObject, deleteObjectsByPrefix } from './s3.js';
import { deleteFileMetadataReturningSize } from '../db/queries/events.js';
import { updateDiskUsage } from '../db/queries/storage.js';
import { CONFIG } from '../config.js';

export type DeleteReason =
  | 'event-delete'
  | 'collapse-view'
  | 'wipe-user'
  | 'backfill'
  | 'reconciler-safety-net'
  | 'reconciler-step-2b'
  | 'auto-delete-evict';

export interface DeleteS3AndMetadataOpts {
  ownerId: number;
  s3Bucket: string;
  s3Key: string;
  reason: DeleteReason;
}

export interface DeleteS3AndMetadataResult {
  s3Deleted: boolean;
  metadataDeleted: boolean;
}

/**
 * Single source of truth for cascading delete of an S3 object plus its
 * file_metadata row. S3-first so a transient S3 error leaves the row
 * intact (reconciler safety net retries). DB delete is owner-scoped.
 * Decrements disk_usage_bytes only when the deleted row was in the
 * recordings bucket — thumbnails and sidecars never counted toward
 * quota, matching the legacy countsTowardQuota check in deleteEventOwned.
 */
export async function deleteS3AndMetadata(
  opts: DeleteS3AndMetadataOpts,
): Promise<DeleteS3AndMetadataResult> {
  const { ownerId, s3Bucket, s3Key, reason } = opts;

  let s3Deleted = false;
  try {
    await deleteObject(s3Bucket, s3Key);
    s3Deleted = true;
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchKey') {
      // idempotent — object already gone, proceed to row delete
    } else {
      throw err;
    }
  }

  const { deleted, fileSizeBytes } = await deleteFileMetadataReturningSize(
    ownerId,
    s3Bucket,
    s3Key,
  );

  if (deleted && fileSizeBytes !== null && fileSizeBytes > 0 && s3Bucket === CONFIG.s3RecordingsBucket) {
    await updateDiskUsage(ownerId, -fileSizeBytes);
  }

  console.info('[file_lifecycle.delete]', {
    ownerId,
    s3Bucket,
    s3Key,
    reason,
    s3Deleted,
    metadataDeleted: deleted,
  });

  return { s3Deleted, metadataDeleted: deleted };
}

/**
 * Delete EVERY sidecar variant for a recording from the sidecars bucket.
 *
 * Sidecars are keyed `{recordingS3Key}.<suffix>` — `.fmp4patch`,
 * `.clean_frame`, `.classic_moov`, `.frames`, and whatever future variants
 * get added. Deleting by the `{recordingS3Key}.` PREFIX removes all of them in
 * one LIST+DeleteObjects, regardless of suffix. This deliberately replaces the
 * old hardcoded per-suffix list, which silently leaked `.frames` (and would
 * leak any new suffix) — the same "forgot a suffix" bug class that left the
 * reconciler's detection blind. Sidecars are never tracked in file_metadata,
 * so there is no row/disk-usage cascade here. Returns the number removed.
 */
export async function deleteSidecarsForRecording(recordingS3Key: string): Promise<number> {
  return deleteObjectsByPrefix(CONFIG.s3SidecarsBucket, `${recordingS3Key}.`);
}

export interface DeleteRecordingAllBucketsOpts {
  ownerId: number;
  recordingS3Key: string;       // klucz w recordings bucket (bez .jpg / .fmp4patch)
  reason: DeleteReason;
}

/**
 * Convenience wrapper for the "this whole recording is gone" case
 * (event delete, collapseEventView). Deletes the recording + its per-recording
 * `.jpg` thumbnail via deleteS3AndMetadata (file_metadata + disk_usage
 * cascade), and ALL sidecar variants via a single prefix-delete. `deletedRows`
 * counts the file_metadata rows actually removed (recording + thumbnail);
 * sidecars carry no file_metadata rows.
 */
export async function deleteRecordingAllBuckets(
  opts: DeleteRecordingAllBucketsOpts,
): Promise<{ deletedRows: number }> {
  const { ownerId, recordingS3Key, reason } = opts;

  const [recResult, thumbResult] = await Promise.all([
    deleteS3AndMetadata({ ownerId, s3Bucket: CONFIG.s3RecordingsBucket, s3Key: recordingS3Key, reason }),
    deleteS3AndMetadata({ ownerId, s3Bucket: CONFIG.s3ThumbnailsBucket, s3Key: `${recordingS3Key}.jpg`, reason }),
    deleteSidecarsForRecording(recordingS3Key),
  ]);

  const deletedRows = [recResult, thumbResult].filter(r => r.metadataDeleted).length;
  return { deletedRows };
}
