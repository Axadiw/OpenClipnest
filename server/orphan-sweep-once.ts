/**
 * Orphan-sweep entrypoint — DAILY cadence (k8s `clipnest-orphan-sweep`).
 *
 * Runs the S3 orphan half of storage reconciliation: per-object detection
 * (orphaned thumbnails + sidecars under live users), the cross-user unowned-
 * prefix scan, and the 7-day auto-purge.
 *
 * WHY THIS IS ITS OWN JOB, AND WHY DAILY
 *
 * It used to be pass 1 of `clipnest-audit` (every 6 h). The sweep took most
 * of that job's time budget, so the job was killed by DeadlineExceeded before
 * reaching retention, quota tidy or upload_events pruning. Those silently
 * stopped running until the cron watchdog fired.
 *
 * Daily is not a compromise, it is the correct cadence. The sweep's only
 * consumer is a purge that waits SEVEN DAYS from `firstSeenAt` before deleting
 * anything, so scanning four times a day was a ~28x mismatch between how often
 * we looked and how fast we acted. Spotting an orphan up to a day later shifts
 * its deletion by up to a day against a 7-day window — noise. Nothing else
 * reads the freshness: `seenCount` and `lastSeenAt` are surfaced in the admin
 * panel but no logic branches on them.
 *
 * DEADLINE: this job gets a much larger one than the audit precisely because
 * it is the unbounded pass, and nothing user-facing waits behind it. A sweep
 * that overruns costs a delayed cleanup; an audit that overruns costs
 * retention.
 */
import { Sentry } from './sentry.js';
import { initDb } from './db/index.js';
import { runStorageReconciliation } from './services/storageReconciler.js';
import { closeRedis } from './utils/redis.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';

// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

async function main(): Promise<void> {
  await initDb();
  const started = Date.now();
  await runStorageReconciliation({ scanOrphans: true });
  console.log(`orphan-sweep: completed in ${Date.now() - started}ms`);
}

main()
  .then(async () => {
    await closeRedis();
    await Sentry.close(200);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('orphan-sweep: FAILED', err instanceof Error ? err.message : String(err));
    Sentry.captureException(err);
    await Sentry.close(2000);
    await closeRedis().catch(() => {});
    process.exit(1);
  });
