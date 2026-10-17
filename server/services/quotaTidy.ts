/**
 * Post-upload + cron-driven quota tidy: when a user's `disk_usage_bytes`
 * exceeds their plan limit AND they have `auto_delete_oldest = true`,
 * walk `file_metadata` oldest-first and evict until usage is back under
 * plan. Runs under a `pg_advisory_lock` keyed on user id so concurrent
 * triggers (8 STOR completions arriving within ~100 ms) don't spawn
 * 8 overlapping eviction loops that race on the same FIFO rows.
 *
 * The loop always rechecks `disk_usage_bytes` from the row before each
 * file delete and stops the moment we're back under plan. No buffer:
 * we evict exactly the minimum needed to fit the quota (per user
 * request 2026-04-30) so users keep as much footage as their plan
 * actually allows.
 */

import {
  getUserQuota,
  getDiskUsage,
  withUserAdvisoryLock,
  getUsersOverQuotaWithAutoDelete,
  getUsersByPlan,
} from '../db/queries/storage.js';
import { getOldestFileForUser } from '../db/queries/events.js';
import { evictFile } from './autoDelete.js';
import { reconcileUserQuota } from './quota-reconciler.js';

export interface TidyResult {
  /** Number of files actually deleted by this run. */
  deleted: number;
  /** Bytes freed across those deletes. */
  freedBytes: number;
  /** True iff another tidy run already held the user lock and we bailed. */
  skipped: boolean;
}

/**
 * Bring a single user's `disk_usage_bytes` back under their plan by
 * deleting the oldest files. Idempotent + concurrency-safe via advisory
 * lock — additional callers while one is running return `skipped: true`
 * without doing any work. Safe to invoke from the post-upload trigger AND
 * the cron sweep at the same time: the lock dedups them.
 *
 * No-op (returns `{deleted: 0, freedBytes: 0, skipped: false}`) when the
 * plan is unlimited (`disk_space_bytes = 0`) or usage is already under
 * the limit at the time the lock is acquired.
 */
export async function evictUserToFitPlan(
  userId: number,
  userUuid: string,
  // Plumbed through for parity with the retention service signature, even
  // though `evictFile` doesn't use it today (the cascade goes through DB
  // column matches, not encrypted-metadata reads). Underscore-prefix
  // satisfies the unused-vars lint without a directive comment.
  _encryptionSalt: string,
): Promise<TidyResult> {
  const result = await withUserAdvisoryLock<TidyResult>(userId, async () => {
    let deleted = 0;
    let freedBytes = 0;

    // Re-read the plan info inside the lock so we don't act on a stale
    // snapshot if the admin changed the plan between trigger and run.
    const quota = await getUserQuota(userId);
    if (!quota || quota.diskLimitBytes <= 0) {
      return { deleted: 0, freedBytes: 0, skipped: false };
    }
    const planLimit = quota.diskLimitBytes;

    while (true) {
      const usage = await getDiskUsage(userId);
      if (usage <= planLimit) break;

      const file = await getOldestFileForUser(userId);
      if (!file) {
        // Library exhausted but still over plan — nothing more we can do.
        // (Happens only if disk_usage_bytes is desync'd from S3 reality;
        // the storage reconciler heals that on its next 1-min tick.)
        break;
      }

      // Defense in depth: if the OLDEST file alone exceeds the plan, no
      // amount of FIFO eviction can converge — deleting it leaves usage at
      // (current - file.size) which may still be over plan, and the next
      // iteration would target the next-oldest, eventually evicting the
      // entire library while the over-plan condition persists. This used
      // to wipe live FTPS uploads.
      // The route-level guard at /disk-claim-and-tidy now rejects oversize
      // uploads upfront, but the cron sweep can still hit this state if an
      // admin retroactively shrinks a plan or storageReconciler backfills
      // a large pre-existing object. Bail with a warning and let
      // observability surface it.
      if (file.fileSizeBytes > planLimit) {
        console.warn(
          `quota-tidy: bailing — oldest file exceeds plan capacity ` +
          `(file.size=${file.fileSizeBytes} > planLimit=${planLimit}, ` +
          `owner=${userId}, key=${file.s3Key}). ` +
          `FIFO eviction cannot converge; admin intervention required.`,
        );
        break;
      }

      try {
        const freed = await evictFile(file, userId, userUuid, 'quota');
        deleted += 1;
        freedBytes += freed;
      } catch (err) {
        console.error(
          `quota-tidy: evictFile failed for owner=${userId} key=${file.s3Key}:`,
          err instanceof Error ? err.message : err,
        );
        // Bail rather than spin — a persistent eviction failure (e.g. S3
        // outage) shouldn't burn CPU until the lock TTL expires. Next
        // trigger / cron tick will retry.
        break;
      }
    }

    return { deleted, freedBytes, skipped: false };
  });

  // `withUserAdvisoryLock` returns null when another caller already holds
  // the lock — surface that distinctly so observability can tell "no work
  // needed" apart from "another run is in flight".
  if (result === null) {
    return { deleted: 0, freedBytes: 0, skipped: true };
  }
  return result;
}

/**
 * Cron sweep: evict every user who is currently over plan AND has the
 * auto-delete-oldest flag on. Runs every 1 min as part of the storage
 * reconciler. Belt-and-suspenders for cases where the post-upload
 * trigger never fired (FTPS pod crashed mid-flight, scheduled flag
 * toggle landed a user above the plan, or `setDiskUsageAbsolute` healed
 * usage upward in the same tick).
 *
 * Returns aggregate counters across every user processed. Each user runs
 * under their own advisory lock, so a slow eviction for one user does
 * not block the sweep for another.
 */
export async function runQuotaTidyForAllUsers(): Promise<{
  usersProcessed: number;
  totalDeleted: number;
  totalFreedBytes: number;
}> {
  const candidates = await getUsersOverQuotaWithAutoDelete();
  let totalDeleted = 0;
  let totalFreedBytes = 0;
  for (const u of candidates) {
    try {
      const r = await evictUserToFitPlan(u.id, u.uuid, u.encryptionSalt);
      totalDeleted += r.deleted;
      totalFreedBytes += r.freedBytes;
    } catch (err) {
      console.error(
        `quota-tidy sweep: user ${u.id} (${u.uuid}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return {
    usersProcessed: candidates.length,
    totalDeleted,
    totalFreedBytes,
  };
}

/**
 * Fan-out tidy for a single plan: when an admin shrinks a plan's storage limit,
 * every user assigned to it may now be over quota. For users who opted into
 * auto-delete, evict the over-limit excess; for everyone on the plan,
 * (re)evaluate the storage warning. Runs instantly (fired in the background
 * from the admin plan-edit route) instead of waiting for the 1-min
 * `runQuotaTidyForAllUsers` cron to walk every user in the system. Each user is
 * isolated so one failure doesn't abort the rest; the cron stays as backstop.
 *
 * Eviction is gated on `autoDeleteOldest` HERE (not inside `evictUserToFitPlan`,
 * which evicts unconditionally) so a downgrade never deletes footage for a user
 * who didn't opt in — they stay over-quota and just receive the warning.
 */
export async function runQuotaTidyForPlan(planId: number): Promise<void> {
  const users = await getUsersByPlan(planId);
  for (const u of users) {
    try {
      if (u.autoDeleteOldest) {
        await evictUserToFitPlan(u.id, u.uuid, u.encryptionSalt);
      }
      await reconcileUserQuota(u.id);
    } catch (err) {
      console.error(
        `quota-tidy plan fan-out: user ${u.id} (${u.uuid}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
