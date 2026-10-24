/**
 * Redrive — one-shot entrypoint for the k8s `clipnest-redrive` CronJob
 * (every 1 min, activeDeadlineSeconds 60). The single minute-cadence safety
 * net of the state-machine pipeline (spec §7): re-publishes thumbnail/sidecar
 * jobs for linked pending_sidecar rows that are due, relinks a bounded batch
 * of orphaned (no-elf) files, re-publishes thumbnail jobs for events that
 * never got one, and recomputes stale playback_ready flags.
 * Replaces reconcile-once.ts' 8-pass monolith together with audit-once.ts
 * (Task 9).
 */
import { captureException, closeErrorReporting } from './errorReporting.js';
import { initDb } from './db/index.js';
import { getSidecarRedriveBatch } from './db/queries/processingState.js';
import { reconcileMissingThumbnails, reconcileStalePlaybackReady } from './services/reconcilers.js';
import { relinkUnlinkedFiles } from './services/ingest/relinkUnlinkedFiles.js';
import { publishThumbnailUnique } from './services/streamsClient.js';
import { closeRedis } from './utils/redis.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';

// Bounded so the relink pass (one completeUpload tx per orphan) can't blow the
// 60s redrive deadline: ~100 × ~50ms ≈ 5s worst case, sub-100ms when empty
// (the steady state). The 6h audit runs the full 500-row variant for bulk
// backfills; this fast lane heals FRESH orphans in ~1 min during the R1
// coexistence window (old-image FTPS pods still on the scan path can lose a
// dual-view second-view row — the exact "hangs in the banner" symptom R1
// targets — and the per-minute orphan reconciler that used to heal it was
// retired with reconcile-once). New sync-ingest uploads can't orphan
// (atomic), so this is purely a rollout-window + legacy-debris safety net.
// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

const REDRIVE_RELINK_LIMIT = 100;

async function main(): Promise<void> {
  await initDb();

  const batch = await getSidecarRedriveBatch();
  let published = 0;
  let deduped = 0;
  for (const { eventId, ownerId } of batch) {
    try {
      const r = await publishThumbnailUnique(eventId, ownerId, { notify: false });
      if (r === 'published') published += 1; else deduped += 1;
    } catch (err) {
      console.error('redrive: publish failed:', err instanceof Error ? err.message : String(err));
    }
  }
  if (batch.length > 0) {
    console.log(`redrive: ${published} published / ${deduped} deduped / ${batch.length} due`);
  }

  try {
    await relinkUnlinkedFiles(REDRIVE_RELINK_LIMIT);
  } catch (err) {
    console.error('redrive: relink failed:', err instanceof Error ? err.message : String(err));
  }

  // Events whose thumbnail job was never queued. The sidecar batch above only
  // sees files still in pending_sidecar, so an event created around an
  // already-ready file (a merge-artifact heal re-homing a displaced view) is
  // invisible to it and would keep a NULL thumbnail forever.
  try {
    await reconcileMissingThumbnails();
  } catch (err) {
    console.error('redrive: missing thumbnails failed:', err instanceof Error ? err.message : String(err));
  }

  try {
    await reconcileStalePlaybackReady();
  } catch (err) {
    console.error('redrive: stale playback_ready failed:', err instanceof Error ? err.message : String(err));
  }
}

main()
  .then(async () => { await closeRedis(); await closeErrorReporting(200); process.exit(0); })
  .catch(async (err) => {
    console.error('redrive: failed:', err instanceof Error ? err.stack ?? err.message : String(err));
    captureException(err);
    await closeErrorReporting(2000);
    await closeRedis().catch(() => {});
    process.exit(1);
  });
