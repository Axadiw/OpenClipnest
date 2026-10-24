// Deleting an account's recordings while keeping the account: file_metadata
// rows and every object under "<uuid>/" in the three content buckets — only
// what existed before `cutoff` — then the events left without any surviving
// file. A file uploaded after the cutoff survives a deletion that is resumed
// later. Rows go first (in one transaction under the account's event lock, so
// the list is empty at once and the usage counter matches what is left),
// objects second; a run that stops early (shouldStop) is finished by a later
// call with the same cutoff — deleting the rows again is a no-op.
//
// The whole call holds the account's LOCK_NS_QUOTA lock, the one the storage
// reconciler and quota tidy hold per user: without it the reconciler could
// re-create rows (and the usage counter) from objects this call has not
// reached yet, and they would survive a call that then reports complete.
import { sql } from 'drizzle-orm';
import { CONFIG } from '../config.js';
import { withUserLock, LOCK_NS_EVENTS } from '../db/index.js';
import {
  deleteEventsWithoutSurvivingFiles, deleteFileMetadataUploadedBefore, detachViewsOfFilesUploadedBefore, recomputeDiskUsage,
} from '../db/queries/events.js';
import { withUserAdvisoryLock } from '../db/queries/storage.js';
import { deleteObjectsByPrefix, isAccountPrefix, UnsafePrefixError, type PrefixDeleteOptions } from './s3.js';

/**
 * Objects are compared with the cutoff minus this margin: the object store's
 * clock is not the database's, and a multipart object's LastModified can be
 * when its upload began. The account was locked for at least 7 days before the
 * cutoff, so nothing it legitimately owns falls inside the margin.
 */
export const OBJECT_CLOCK_MARGIN_MS = 600_000;

export interface WipeResult { objectsRemoved: number; rowsRemoved: number; complete: boolean }
export interface WipeProgress { objectsRemoved: number; rowsRemoved: number }

/** What a wipe that threw had removed before the throw, when it got that far. */
export function wipeProgressOf(err: unknown): WipeProgress | null {
  const p = (err as { wipeProgress?: WipeProgress } | null)?.wipeProgress;
  return p && typeof p.objectsRemoved === 'number' && typeof p.rowsRemoved === 'number' ? p : null;
}
export type DeleteObjectsFn = (bucket: string, prefix: string, opts: PrefixDeleteOptions) => Promise<{ deleted: number; complete: boolean }>;

/**
 * Returns complete: false (nothing deleted) when another process holds the
 * account's LOCK_NS_QUOTA lock — the next run tries again. Throws, deleting
 * nothing, when `owner.uuid` is not the uuid of `owner.id` or is not a single
 * path segment. A throw after the rows are gone (an S3 failure) leaves the
 * deletion unfinished, exactly like complete: false.
 */
export async function wipeRecordingsBefore(
  owner: { id: number; uuid: string },
  cutoff: Date,
  { shouldStop = () => false, deleteObjects = deleteObjectsByPrefix }: { shouldStop?: () => boolean; deleteObjects?: DeleteObjectsFn } = {},
): Promise<WipeResult> {
  const result = await withUserAdvisoryLock(owner.id, async (): Promise<WipeResult> => {
    const prefix = `${owner.uuid}/`;
    const rowsRemoved = await withUserLock(LOCK_NS_EVENTS, owner.id, async (tx) => {
      // Never trust the caller's uuid: the S3 prefix and the rel-path relation
      // both come from it, and a wrong one would delete another account's
      // objects or every event of this one. Checked before any DELETE.
      const { rows } = await tx.execute<{ uuid: string }>(sql`SELECT uuid FROM users WHERE id = ${owner.id}`);
      if (rows[0]?.uuid !== owner.uuid) {
        throw new Error(`wipeRecordingsBefore: uuid does not belong to user ${owner.id}`);
      }
      if (!isAccountPrefix(prefix)) throw new UnsafePrefixError(prefix);
      await detachViewsOfFilesUploadedBefore(owner, cutoff, tx);
      const files = await deleteFileMetadataUploadedBefore(owner.id, cutoff, tx);
      const events = await deleteEventsWithoutSurvivingFiles(owner, cutoff, tx);
      await recomputeDiskUsage(owner.id, tx);
      return files + events;
    });
    const modifiedBefore = new Date(cutoff.getTime() - OBJECT_CLOCK_MARGIN_MS);
    let objectsRemoved = 0;
    try {
      for (const bucket of [CONFIG.s3RecordingsBucket, CONFIG.s3ThumbnailsBucket, CONFIG.s3SidecarsBucket]) {
        const r = await deleteObjects(bucket, prefix, { modifiedBefore, shouldStop });
        objectsRemoved += r.deleted;
        if (!r.complete) return { objectsRemoved, rowsRemoved, complete: false };
      }
    } catch (err) {
      // The rows are gone and will not be counted again on the resumed call:
      // hand what was removed so far to the caller (objects of the bucket that
      // threw are not known here — at most one bucket's partial count is lost).
      if (err && typeof err === 'object') Object.assign(err, { wipeProgress: { objectsRemoved, rowsRemoved } satisfies WipeProgress });
      throw err;
    }
    return { objectsRemoved, rowsRemoved, complete: true };
  });
  return result ?? { objectsRemoved: 0, rowsRemoved: 0, complete: false };
}
