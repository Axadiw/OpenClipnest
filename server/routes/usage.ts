import { Router } from 'express';
import {
  getUserQuota, checkAndResetTransfer, getAutoDeleteOldest, setAutoDeleteOldest,
  getAutoDeleteAfterDays, setAutoDeleteAfterDays, getDiskUsageByCamera,
} from '../db/queries/storage.js';
import { getUserByUuid } from '../db/queries/users.js';
import { evictUserToFitPlan } from '../services/quotaTidy.js';
import { runRetentionForUser } from '../services/autoDeleteRetention.js';
import { isAccessLocked } from '../db/queries/access.js';
import { requireOwner } from '../middleware/editionGuards.js';

const router = Router();

// The owner routes below carry `requireOwner`: in Clipnest Cloud the admin
// account has no personal quota, so its guard answers 403; self-hosted passes.

/**
 * GET /api/v0/usage — content owner: get own quota/usage data.
 */
router.get('/', requireOwner, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  // Lazy transfer reset
  await checkAndResetTransfer(userId);

  const quota = await getUserQuota(userId);
  if (!quota) { res.status(404).json({ error: 'Quota data not found' }); return; }

  const diskPercent = quota.diskLimitBytes > 0
    ? Math.round((quota.diskUsageBytes / quota.diskLimitBytes) * 100)
    : 0;
  const transferPercent = quota.transferLimitBytes > 0
    ? Math.round((quota.transferUsageBytes / quota.transferLimitBytes) * 100)
    : 0;

  res.json({
    disk: {
      usageBytes: quota.diskUsageBytes,
      limitBytes: quota.diskLimitBytes,
      percent: diskPercent,
    },
    transfer: {
      usageBytes: quota.transferUsageBytes,
      limitBytes: quota.transferLimitBytes,
      percent: transferPercent,
      resetAt: quota.transferResetAt,
    },
    accessLocked: await isAccessLocked(userId),
  });
});

/**
 * GET /api/v0/usage/by-camera — Per-camera disk-usage breakdown for the
 * current user. Powers the storage breakdown viz in Settings → Storage.
 *
 * Returns `cameras: Array<{ cameraName, bytes, durationSeconds, eventCount }>`
 * sorted by bytes DESC. The sum of `bytes` may be slightly less than
 * `getUserQuota().diskUsageBytes` — orphan file_metadata rows that haven't
 * been correlated with an event are excluded by design (see db.ts).
 */
router.get('/by-camera', requireOwner, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const cameras = await getDiskUsageByCamera(userId);
  res.json({ cameras });
});

/**
 * GET /api/v0/usage/auto-delete — user reads own auto-delete-oldest flag.
 */
router.get('/auto-delete', requireOwner, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  res.json({ enabled: await getAutoDeleteOldest(userId) });
});

/**
 * PUT /api/v0/usage/auto-delete — user toggles own auto-delete-oldest flag.
 * Body: { enabled: boolean }
 */
router.put('/auto-delete', requireOwner, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }
  await setAutoDeleteOldest(userId, enabled);
  if (enabled) {
    // Instant eviction: enabling auto-delete while already over plan should free
    // space now, not wait up to 1 min for the quota-tidy cron. Fire-and-forget;
    // evictUserToFitPlan is idempotent + advisory-locked, so it dedups against
    // the cron and the post-upload trigger.
    const u = await getUserByUuid(req.user!.userUuid);
    if (u?.encryptionSalt) {
      const { internalId, id: uuid, encryptionSalt } = u;
      setImmediate(() => {
        evictUserToFitPlan(internalId, uuid, encryptionSalt).catch((err) =>
          console.error('auto-delete enable: instant eviction failed:', err instanceof Error ? err.message : err),
        );
      });
    }
  }
  res.json({ enabled });
});

/**
 * GET /api/v0/usage/auto-delete-after-days — read the retention window. Returns
 * `{ days: null }` when retention is off, otherwise `{ days: number }` in days.
 */
router.get('/auto-delete-after-days', requireOwner, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  res.json({ days: await getAutoDeleteAfterDays(userId) });
});

/**
 * PUT /api/v0/usage/auto-delete-after-days — set or clear the retention
 * window. Body: { days: number | null }. `null` disables; a positive integer
 * in [1, 365] enables eviction of files whose `file_metadata.uploaded_at` is
 * older than the window. Out-of-range or non-integer values are rejected
 * with 400 to keep bad clients from accidentally wiping a user's library.
 */
router.put('/auto-delete-after-days', requireOwner, async (req, res) => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const days = req.body?.days;
  if (days === null) {
    await setAutoDeleteAfterDays(userId, null);
    res.json({ days: null });
    return;
  }
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
    res.status(400).json({ error: 'days must be null or an integer in [1, 365]' });
    return;
  }
  await setAutoDeleteAfterDays(userId, days);
  // Instant retention: shortening the window leaves now-stale files behind. Run
  // the retention sweep for this user immediately instead of waiting for the
  // 1-min cron. Fire-and-forget; runRetentionForUser is capped (500/run) +
  // idempotent, and re-applies the just-saved window.
  const u = await getUserByUuid(req.user!.userUuid);
  if (u?.encryptionSalt) {
    const { internalId, id: uuid, encryptionSalt } = u;
    setImmediate(() => {
      runRetentionForUser(internalId, uuid, encryptionSalt, days).catch((err) =>
        console.error('retention change: instant sweep failed:', err instanceof Error ? err.message : err),
      );
    });
  }
  res.json({ days });
});

export default router;
