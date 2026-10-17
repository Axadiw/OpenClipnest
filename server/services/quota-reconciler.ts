/**
 * Quota reconciler: checks whether a user's disk usage crowds the plan limit.
 *
 * Two distinct signals, both gated on the user NOT having any auto-delete
 * configured (users who opted into eviction are kept silent — their storage
 * pressure is handled automatically and shouldn't flood the inbox/feed):
 *
 *   90% threshold — warning delivered by the edition hook (Clipnest Cloud
 *     emails the user, max once per 7 days; self-hosted has no channel).
 *
 *   95% threshold — in-app notification (storage_quota_exceeded), deduped to
 *     at most one per 7-day window via hasRecentNotification so the inline +
 *     cron triggers below can't mint a fresh row every tick.
 *
 * Triggered from three places: the inline FTPS upload path (disk-claim-and-tidy)
 * the moment an accepted upload crosses 90/95%; the admin `PUT /users/:id/plan`
 * handler after a plan switch; and the storageReconciler cron every 1 min as
 * the catch-all backstop (for FTPS-only users who plateau over the line and
 * never trip the inline crossing).
 */
import { getUserQuota, getAutoDeleteOldest, getStorageWarnState } from '../db/queries/storage.js';
import { createNotification, hasRecentNotification } from '../db/queries/notifications.js';
import { editionHooks } from '../hooks.js';

export const QUOTA_WARN_THRESHOLD = 0.95;
export const STORAGE_WARN_EMAIL_THRESHOLD = 0.90;
/** Minimum milliseconds between storage warnings (and in-app dedup window) for the same user. */
export const STORAGE_WARN_EMAIL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReconcileResult {
  skipped: boolean;
  overLimit: boolean;
  percent: number;
  notified: boolean;
  warnEmailSent: boolean;
}

export async function reconcileUserQuota(userId: number): Promise<ReconcileResult> {
  const quota = await getUserQuota(userId);
  if (!quota || quota.diskLimitBytes <= 0) {
    return { skipped: true, overLimit: false, percent: 0, notified: false, warnEmailSent: false };
  }
  const percent = quota.diskUsageBytes / quota.diskLimitBytes;
  if (percent < STORAGE_WARN_EMAIL_THRESHOLD) {
    return { skipped: false, overLimit: false, percent, notified: false, warnEmailSent: false };
  }

  const overLimit = quota.diskUsageBytes > quota.diskLimitBytes;

  // ── 90 % warning ───────────────────────────────────────────────────────────
  // Delivered by the edition hook (server/hooks.ts): Clipnest Cloud emails the
  // user with its own 7-day cooldown; a self-hosted install has no hook, so
  // nothing is sent. Skip when either auto-delete flag is active: the user
  // already has a mechanism to prevent uploads from failing, so warning them
  // would be noise.
  let warnEmailSent = false;
  const warnState = await getStorageWarnState(userId);
  const bothAutoDeleteOff =
    warnState !== null &&
    !warnState.autoDeleteOldest &&
    warnState.autoDeleteAfterDays === null;

  if (bothAutoDeleteOff) {
    warnEmailSent = (await editionHooks().storageWarning?.({
      userId,
      email: warnState!.email,
      lastWarnedAt: warnState!.storageWarnEmailSentAt,
      diskUsageBytes: quota.diskUsageBytes,
      diskLimitBytes: quota.diskLimitBytes,
      percent,
    })) ?? false;
  }

  // ── 95 % in-app notification ───────────────────────────────────────────────
  if (percent < QUOTA_WARN_THRESHOLD) {
    return { skipped: false, overLimit, percent, notified: false, warnEmailSent };
  }

  if (await getAutoDeleteOldest(userId)) {
    // User opted into auto-delete — silent. Eviction is handled inline by the
    // FTPS pre-upload + post-claim retry path and by the retention cron; no
    // notification is needed. Returning notified:false documents the choice.
    return { skipped: false, overLimit, percent, notified: false, warnEmailSent };
  }

  // Dedup: this function is now reachable from three triggers — the inline
  // upload path (disk-claim-and-tidy), the admin plan-change handler, and the
  // 1-min reconciler backstop. Without a cooldown the backstop alone would
  // mint a fresh `storage_quota_exceeded` row every tick for a user who
  // plateaus over the line. Reuse the email's 7-day window so the in-app
  // signal matches the email cadence; createdAt-based, so no extra column.
  if (await hasRecentNotification(userId, 'storage_quota_exceeded', STORAGE_WARN_EMAIL_COOLDOWN_MS)) {
    return { skipped: false, overLimit, percent, notified: false, warnEmailSent };
  }

  await createNotification(
    userId,
    'storage_quota_exceeded',
    overLimit
      ? 'Storage is over its limit. Free some space or raise the limit.'
      : 'Storage is near its limit. Free some space or raise the limit.',
    {
      diskUsageBytes: quota.diskUsageBytes, diskLimitBytes: quota.diskLimitBytes, percent,
      locKey: overLimit ? 'notif.storage_quota_exceeded.over' : 'notif.storage_quota_exceeded.near',
      locArgs: [],
    },
  );
  return { skipped: false, overLimit, percent, notified: true, warnEmailSent };
}
