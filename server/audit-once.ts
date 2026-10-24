/**
 * Audit entrypoint — 6-hour cadence (k8s `clipnest-audit`, deadline 1200s).
 *
 * Passes (in order):
 *   1. runStorageReconciliation — S3 ↔ DB reconcile + zombie cleanup
 *                                 (orphan sweep EXCLUDED — see below)
 *   2. relinkUnlinkedFiles     — heal legacy fm rows with no elf (audit-path healer)
 *   3. runQuotaTidyForAllUsers — auto-evict oldest files for users over plan
 *   4. purgeOldUploadEvents    — 30d rolling-window reaper
 *   5. runRetentionForAllUsers — date-based retention sweep
 *
 * The S3 orphan sweep is NOT part of this job — it runs daily in
 * orphan-sweep-once.ts. It used to run here as part of pass 1 and grew to
 * most of this job's deadline, so the job was killed by DeadlineExceeded
 * every run and passes 2-5 never executed at all. Retention silently stopped
 * until the cron watchdog's staleness threshold fired.
 *
 * That ordering is the standing hazard here: pass 1 runs FIRST and everything
 * that actually deletes user data runs after it. Anything in pass 1 must be
 * bounded, or it starves the rest.
 *
 * Excluding the orphan sweep was not enough on its own. What remained of pass 1
 * still scales with total object count, so a FIXED job deadline is a shrinking
 * budget: the pass took a growing share of it until the job resumed dying on
 * DeadlineExceeded, retention included. Pass 1 now
 * carries its own wall-clock budget (`stepOneBudgetMs`) and stops at a user
 * boundary instead of consuming the deadline the deletions depend on. The
 * deadline is sized as budget + one heavy user's overshoot + the tail, with
 * headroom — not fitted to today's measurement.
 *
 * Diagnosing the next recurrence: the pod is deleted on DeadlineExceeded and a
 * SIGKILLed run flushes nothing to Sentry, so there are no logs afterwards.
 * Pass 1's duration IS recorded — `storage_reconciliation_runs.duration_ms`,
 * where the audit-path rows are the ones with `orphans_found = 0`.
 *
 * Replaces reconcile-once.ts as part of the R1 pipeline redesign (spec §9).
 * redrive-once.ts handles the per-minute sidecar re-publish + stale-playback
 * passes that were previously in reconcile-once.
 *
 * `concurrencyPolicy: Forbid` on the CronJob prevents overlap between runs.
 */

import { captureException, closeErrorReporting } from './errorReporting.js';
import { initDb } from './db/index.js';
import { purgeOldUploadEvents } from './db/queries/storage.js';
import { runStorageReconciliation } from './services/storageReconciler.js';
import { runRetentionForAllUsers } from './services/autoDeleteRetention.js';
import { runQuotaTidyForAllUsers } from './services/quotaTidy.js';
import { abortStaleMultipartUploads } from './services/multipartCleanup.js';
import { backfillFrameRates } from './services/reconcilers.js';
import { relinkUnlinkedFiles } from './services/ingest/relinkUnlinkedFiles.js';
import { closeRedis } from './utils/redis.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';

// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

async function main(): Promise<void> {
  await initDb();

  // Reconciliation FIRST so the file_metadata backfill from S3 LastModified
  // is fresh before retention/tidy pick the FIFO key. New users + new uploads
  // since the last tick land in the queue this pass.
  //
  // Two independent bounds, because one was not enough (see module docstring):
  //   scanOrphans: false  — the orphan sweep runs in its own daily job.
  //   stepOneBudgetMs     — a hard wall-clock stop on what's left, so growth in
  //                         the per-user pass can never again consume the
  //                         deadline that retention and quota tidy depend on.
  // 600s against the CronJob's 1200s: today pass 1 needs ~296s, so the budget
  // is a safety valve rather than a routine truncation, and the remaining 600s
  // covers one heavy user's overshoot past the boundary check plus the ~250s
  // tail of destructive passes below.
  await runStorageReconciliation({ scanOrphans: false, stepOneBudgetMs: 600_000 });

  // Legacy-orphan healer — fm rows in pending_sidecar with no event_view_files
  // row (orphaned from the pre-R1 scan era, or rows whose ingest tx raced a
  // deploy). Runs through completeUpload (idempotent on s3_key). Comes
  // AFTER storageReconciliation so newly-backfilled fm rows are visible.
  try {
    const healed = await relinkUnlinkedFiles();
    if (healed > 0) {
      console.log(`audit: relinkUnlinkedFiles healed ${healed} orphaned fm row(s)`);
    }
  } catch (err) {
    console.error('audit: relinkUnlinkedFiles failed:', err instanceof Error ? err.message : err);
  }

  // Frame-rate backfill — writes event_view_files.frame_rate for files whose
  // sidecar predates fps extraction (master's a024b3b, re-homed here from the
  // retired reconcile-once). Bulk + self-quiescing once all rows have a
  // non-NULL frame_rate; a no-op in steady state, so the 6h audit cadence is
  // the right home (not the 1-min redrive hot path).
  try {
    await backfillFrameRates();
  } catch (err) {
    console.error('audit: frame-rate backfill failed:', err instanceof Error ? err.message : err);
  }

  // Quota tidy sweep — for every user whose `disk_usage_bytes` is above
  // their plan AND who has `auto_delete_oldest = true`, walk file_metadata
  // oldest-first until usage fits. Backstop for the post-upload trigger
  // (which is fire-and-forget over HTTP and could miss on crashes); also
  // catches users who just enabled the flag while already over plan.
  try {
    const tidy = await runQuotaTidyForAllUsers();
    if (tidy.totalDeleted > 0) {
      console.log(
        `Quota tidy: ${tidy.usersProcessed} user(s) over plan, ` +
        `${tidy.totalDeleted} file(s) deleted, ` +
        `${tidy.totalFreedBytes} bytes freed`,
      );
    } else if (tidy.usersProcessed > 0) {
      console.log(`Quota tidy: ${tidy.usersProcessed} user(s) checked — nothing to evict`);
    }
  } catch (err) {
    console.error('quota tidy failed:', err instanceof Error ? err.message : err);
  }

  // Reaper for upload_events — keeps the 30d rolling-window log from
  // growing unboundedly. Cheap (single indexed DELETE).
  try {
    const purged = await purgeOldUploadEvents(30);
    if (purged > 0) {
      console.log(`Upload events: pruned ${purged} row(s) older than 30 days`);
    }
  } catch (err) {
    console.error('upload-events reaper failed:', err instanceof Error ? err.message : err);
  }

  // Abort stale incomplete multipart uploads — interrupted FTPS STORs leave
  // orphaned parts that bill storage but are invisible to ListObjectsV2, and
  // an object store without a lifecycle rule never expires them, so they pile
  // up. Best-effort: never fail the audit.
  try {
    const mpu = await abortStaleMultipartUploads();
    if (mpu.aborted > 0 || mpu.failed > 0) {
      console.log(`Multipart cleanup: aborted ${mpu.aborted}, ${mpu.failed} failure(s)`);
    }
  } catch (err) {
    console.error('multipart cleanup failed:', err instanceof Error ? err.message : err);
  }

  const retention = await runRetentionForAllUsers();
  if (retention.totalDeleted > 0) {
    console.log(
      `Retention: ${retention.usersProcessed} user(s), ` +
      `${retention.totalDeleted} file(s) deleted, ` +
      `${retention.totalFreedBytes} bytes freed`,
    );
  } else if (retention.usersProcessed > 0) {
    console.log(`Retention: ${retention.usersProcessed} user(s) checked — nothing to delete`);
  }
}

main()
  .then(async () => {
    await closeRedis();
    // Happy-path flush: 200 ms is plenty for a healthy error-reporting
    // endpoint, and short enough that an outage there doesn't push this
    // CronJob past its deadline budget. Dropped warn events on a degraded
    // endpoint are acceptable — they're diagnostic-grade, not audit-critical.
    await closeErrorReporting(200);
    process.exit(0);
  })
  .catch(async err => {
    console.error('audit-once: failed:', err instanceof Error ? err.stack ?? err.message : String(err));
    captureException(err);
    // Catch-path keeps 2000 ms — a captured exception is the rare event we
    // really want delivered, and the pod is about to exit anyway.
    await closeErrorReporting(2000);
    await closeRedis().catch(() => {});
    process.exit(1);
  });
