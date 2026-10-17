import { CONFIG } from '../config.js';
import { deleteEvent } from '../db/queries/events.js';
import { recordEventsDeleted, originFor, type EventDeleteReason } from '../utils/metrics.js';
import { deleteObject } from './s3.js';

/**
 * Best-effort removal of the GENERATED thumbnail for `eventId`. The
 * thumbnail-worker writes previews to a deterministic key:
 *   `{userUuid}/__generated__/{eventId}.jpg` in CONFIG.s3ThumbnailsBucket
 *
 * A missing object is normal (worker may not have run yet), and any
 * failure is logged but not rethrown — the DB row removal is the source
 * of truth.
 *
 * Standalone helper because the event-manager delete-notify hot path
 * removes the file (and prunes the now-empty event) via
 * `removeDeletedFileFromEvents` (atomic, path-based, no S3 LIST), then
 * needs only the thumbnail cleanup as a follow-up.
 */
export async function deleteGeneratedThumbnail(
  eventId: string,
  userUuid: string,
): Promise<void> {
  const thumbKey = `${userUuid}/__generated__/${eventId}.jpg`;
  try {
    await deleteObject(CONFIG.s3ThumbnailsBucket, thumbKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/NotFound|NoSuchKey/i.test(msg)) {
      console.warn(`deleteGeneratedThumbnail: ${thumbKey}: ${msg}`);
    }
  }
}

/**
 * Delete an event row AND its generated thumbnail. Used by callers that
 * retire an event by ID with no further per-message logic (auto-delete-
 * oldest, reconciler "no media remains" sweep, scanner full-rescan).
 * The FTPS delete-notify hot path uses the atomic primitive directly
 * and calls `deleteGeneratedThumbnail` separately.
 *
 * `reason` is required rather than defaulted: it is the only thing that
 * distinguishes "the user deleted a recording" from "the quota evictor freed
 * space" on the activity dashboard, and a default would silently mislabel
 * whichever caller forgot to pass one.
 */
export async function deleteEventAndThumbnail(
  eventId: string,
  ownerId: number,
  userUuid: string,
  reason: EventDeleteReason,
): Promise<void> {
  await deleteEvent(eventId, ownerId);
  recordEventsDeleted(reason, originFor(userUuid));
  await deleteGeneratedThumbnail(eventId, userUuid);
}
