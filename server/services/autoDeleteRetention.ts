/**
 * Retention-based auto-delete: removes files whose `file_metadata.uploaded_at`
 * is older than the user's configured `auto_delete_after_days` window.
 * Driven by the reconciler CronJob (every 1 min in production) — proactive,
 * always-on cleanup independent from the reactive near-limit eviction in
 * `autoDelete.ts`.
 *
 * Both services share `evictFile` from `autoDelete.ts` so the per-file
 * cascade (S3 delete + event-column null + event-row delete + generated
 * thumbnail cleanup + file_metadata + disk-usage decrement) stays identical
 * regardless of which trigger fired.
 */
import { getOldestFileOlderThan } from '../db/queries/events.js';
import { getUsersWithRetention } from '../db/queries/storage.js';
import { evictFile } from './autoDelete.js';

/**
 * Hard cap per user per scheduler tick. Looser than the inline near-limit
 * cap (50) because retention runs out-of-band on a 1-min cadence — a single
 * tick that walks 500 stale files is fine, and a brand-new "delete files
 * older than 7 days" toggle on a heavy account drains over a few ticks
 * rather than fighting a tighter cap.
 */
const MAX_DELETIONS_PER_USER_PER_RUN = 500;

export interface RetentionResult {
  deleted: number;
  freedBytes: number;
}

export async function runRetentionForUser(
  userId: number,
  userUuid: string,
  _encryptionSalt: string,
  days: number,
): Promise<RetentionResult> {
  if (days <= 0) return { deleted: 0, freedBytes: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let freedBytes = 0;

  while (deleted < MAX_DELETIONS_PER_USER_PER_RUN) {
    const file = await getOldestFileOlderThan(userId, cutoff);
    if (!file) break;
    freedBytes += await evictFile(file, userId, userUuid, 'retention');
    deleted++;
  }

  return { deleted, freedBytes };
}

export async function runRetentionForAllUsers(): Promise<{
  usersProcessed: number;
  totalDeleted: number;
  totalFreedBytes: number;
}> {
  const users = await getUsersWithRetention();
  let totalDeleted = 0;
  let totalFreedBytes = 0;

  for (const u of users) {
    if (!u.encryptionSalt) continue; // user provisioning incomplete; skip
    try {
      const r = await runRetentionForUser(u.id, u.uuid, u.encryptionSalt, u.autoDeleteAfterDays);
      totalDeleted += r.deleted;
      totalFreedBytes += r.freedBytes;
    } catch (err) {
      console.error(
        `Retention auto-delete failed for user ${u.uuid}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { usersProcessed: users.length, totalDeleted, totalFreedBytes };
}
