/**
 * Periodic-reconciler helpers shared by the k8s `scan-once` CronJob entry
 * and the in-process compose-mode loop in `scanner-entry.ts`.
 *
 * Background: the scanner publishes thumbnail jobs at scan time. Some
 * events legitimately end up without a thumbnail even after a full scan
 * pass — XACK'd without writing the thumbnail (pod OOM, SIGTERM during
 * redeploy, transient S3 hiccup). The reconciler re-publishes these.
 *
 * Idempotent: SETNX-dedup'd `publishThumbnailUnique` makes a "missing"
 * event re-published every minute a no-op once the worker is in flight.
 * Poison-pill events tombstoned by the worker (`THUMBNAIL_UNPLAYABLE`)
 * drop out of the missing-thumbnail query, so the loop terminates without
 * needing a separate visited-set.
 */

import type { Readable } from 'stream';
import {
  getEventsMissingThumbnail,
  getStalePlaybackReadyEventIds,
  recomputeEventsPlaybackReadyForEvent,
  getViewsMissingFrameRate,
  updateEventViewFrameRate,
} from '../db/queries/events.js';
import { publishThumbnailUnique } from './streamsClient.js';
import { getObject, headObject } from './s3.js';
import { indexFragmentedMp4 } from './mp4/fragmentIndex.js';
import { frameRateFromIndex } from './mp4/sidecarBuilder.js';
import { CONFIG } from '../config.js';
/**
 * Called for each event that needs a thumbnail generated. `notify` is true only
 * for fresh-discovery (ingest) events — it gates the worker's new_recording
 * push. Repair/backfill callers pass false so a backlog sweep never announces.
 */
export type ThumbnailPublisher = (eventId: string, ownerId: number, notify: boolean) => void;

// Cap per reconciler pass. Stream is MAXLEN ~10000 and 3 workers × concurrency
// 5 ≈ ~8 thumbs/sec; a 1000-event burst drains in ~2 min, well before the next
// tick. Raising this cap risks crowding out fresh-event jobs from live uploads.
const THUMBNAIL_RECONCILE_BATCH = 1000;

export async function reconcileMissingThumbnails(): Promise<void> {
  const missing = await getEventsMissingThumbnail(THUMBNAIL_RECONCILE_BATCH);
  if (missing.length === 0) return;
  let published = 0;
  let deduped = 0;
  for (const ev of missing) {
    try {
      // Repair sweep → notify=false: these events already exist, so even a
      // fresh one announced from its own ingest job; never re-announce here.
      const r = await publishThumbnailUnique(ev.id, ev.ownerId, { notify: false });
      if (r === 'published') published += 1;
      else deduped += 1;
    } catch (err) {
      console.error('reconciler: thumbnail publish failed:', err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`reconciler: thumbnail reconciled ${published} published / ${deduped} deduped / ${missing.length} pending`);
}

/**
 * Flip stale not-ready events visible — the safety-net half of the
 * playback_ready fix for events (re)created AFTER their files were already
 * patch-ready (full-rescan displaced-event synthesis, slot heals, admin
 * rescans). `markPlaybackPatchReady` never fires again for those files, so
 * the event sits at playback_ready=FALSE and is invisible in the grid even
 * though everything about it is done. The real-time half lives in the thumbnail
 * worker's skipped-already-ready branch, but that only heals events that
 * receive another job; this sweep catches rows that never do.
 *
 * Per-event recompute: `getStalePlaybackReadyEventIds` returns individual
 * stale event ids (bounded by LIMIT 500 per pass) so each recompute is
 * O(elf rows for that one event), never O(all owner events × files).
 *
 * Termination invariant: after a recompute the event's flags are
 * playback_ready=TRUE (or playback_unplayable=TRUE) and it no longer matches
 * `getStalePlaybackReadyEventIds`, so the sweep self-quiesces — no
 * visited-set needed.
 *
 * Logs ONLY when something was recomputed: unlike the thumbnail/sidecar
 * reconcilers above (whose pending counts are the operational signal worth
 * printing every pass), this pass is expected to be empty ~always, and
 * silence on empty keeps the minute-cadence logs clean.
 */
export async function reconcileStalePlaybackReady(): Promise<void> {
  const eventIds = await getStalePlaybackReadyEventIds(500);
  if (eventIds.length === 0) return;
  let recomputed = 0;
  for (const eventId of eventIds) {
    try {
      await recomputeEventsPlaybackReadyForEvent(eventId);
      recomputed += 1;
    } catch (err) {
      console.error(
        `reconciler: stale playback_ready recompute failed for event ${eventId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (recomputed > 0) {
    console.log(`reconciler: stale playback_ready — recomputed ${recomputed} event(s)`);
  }
}

// Bounded per pass — enough to drain a moderate backlog quickly (one reconcile
// pass per minute; 200 rows/pass = 12k/hour) while keeping the pass under 30 s.
const FRAME_RATE_BACKFILL_BATCH = 200;

/**
 * Backfill `event_view_files.frame_rate` for rows that were created before
 * A2 wired fps extraction into the sidecar-build path, and optionally
 * re-backfill rows that already hold the wrong ~10× value from the old
 * `frameRateFromTrex` path.
 *
 * For each row with `frame_rate IS NULL` (or `> 121` when
 * `CLIPNEST_REFRESH_FRAME_RATES=true`) and an existing sidecar on S3:
 *   1. HEAD the ORIGINAL recording to get its file size.
 *   2. Fetch a head window of the original, then build a RangeFetcher.
 *   3. Index the file with `indexFragmentedMp4` to get real sample counts.
 *   4. Compute fps via `frameRateFromIndex` (totalSamples / totalSeconds).
 *   5. Write fps (or sentinel -1 for "tried but undeterminable") so the row
 *      never re-appears in the query (self-quiescing once all rows are fixed).
 *
 * Sentinel -1: the WHERE clause covers NULL (and optionally > 121), so -1 stops
 * retrying without a separate "tried" flag. The API serialises fps only when
 * `frame_rate > 0`, so -1 is never exposed to clients.
 *
 * S3 read errors leave frame_rate NULL — the row is retried next pass (transient
 * network hiccup) which is the safer behaviour than tombstoning a live file.
 *
 * The re-backfill flag (`CLIPNEST_REFRESH_FRAME_RATES=true`) is self-quiescing:
 * once a row is corrected to ~15 fps it no longer matches `> 121`, so the sweep
 * terminates naturally without a visited-set.
 */
// 4 MiB head window — same as fmp4PatchWorker; fits moov for all known Reolink files.
const BACKFILL_HEAD_BYTES = 4 * 1024 * 1024;

export async function backfillFrameRates(batch = FRAME_RATE_BACKFILL_BATCH): Promise<void> {
  const includeWrong = process.env.CLIPNEST_REFRESH_FRAME_RATES === 'true';
  const rows = await getViewsMissingFrameRate(batch, includeWrong);
  if (rows.length === 0) return;
  let filled = 0;
  for (const row of rows) {
    const salt = row.encryptionSalt ?? '';
    let fps: number | null;
    try {
      // HEAD the original recording to learn its file size.
      const { contentLength: fileSize } = await headObject(CONFIG.s3RecordingsBucket, row.s3Key, salt);
      // Fetch the head window of the original (up to 4 MiB, or the full file
      // if smaller). The fragmentIndex parser may issue additional range-fetches
      // via `fetchRange` for moof boxes that fall outside the head window.
      const headEnd = Math.min(BACKFILL_HEAD_BYTES, fileSize) - 1;
      const { body: headBody } = await getObject(CONFIG.s3RecordingsBucket, row.s3Key, salt, `bytes=0-${headEnd}`);
      const headChunks: Buffer[] = [];
      let headTotal = 0;
      for await (const chunk of headBody as Readable) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        headTotal += b.length;
        headChunks.push(b);
      }
      const headBuf = Buffer.concat(headChunks, headTotal);
      const fetchRange = async (start: number, end: number): Promise<Buffer> => {
        const { body } = await getObject(CONFIG.s3RecordingsBucket, row.s3Key, salt, `bytes=${start}-${end}`);
        const rangeChunks: Buffer[] = [];
        let rangeTotal = 0;
        for await (const chunk of body as Readable) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          rangeTotal += b.length;
          rangeChunks.push(b);
        }
        return Buffer.concat(rangeChunks, rangeTotal);
      };
      const index = await indexFragmentedMp4(headBuf, fileSize, fetchRange);
      fps = frameRateFromIndex(index);
    } catch {
      // S3 read error, HEAD failure, or index parse error — leave frame_rate
      // NULL (or its current wrong value) so the row retries next pass.
      continue;
    }
    try {
      // fps=null → sentinel -1 (tried but undeterminable, e.g. classic MP4 or VFR with zero duration)
      await updateEventViewFrameRate(row.eventId, row.ownerId, row.videoRelPath, fps ?? -1);
      if (fps != null) filled++;
    } catch {
      // DB write error — leave frame_rate unchanged and retry next pass.
    }
  }
  console.log(`[backfillFrameRates] filled ${filled}/${rows.length}`);
}

/**
 * Wrap the SETNX-dedup'd thumbnail publisher so the one-shot CronJob
 * entrypoints (`scan-once.ts`, `redrive-once.ts`) can DRAIN in-flight
 * publishes before they close Redis.
 *
 * `runScan` (and the orphan/unmerged-lens reconcilers) call the publisher
 * fire-and-forget so a sweep isn't blocked per-event on the XADD round-trip.
 * The catch: the entrypoint's `.then()` handler calls `closeRedis()` the
 * moment `main()` resolves, and `quit()` tears the connection down out from
 * under any publish still between its SETNX and its XADD — ioredis then
 * rejects the XADD with "Connection is closed.".
 *
 * `drain()` awaits every tracked publish so `main()` only resolves once the
 * stream has actually absorbed the jobs. Failures stay swallowed + logged
 * (one bad XADD must not abort the sweep), so `drain()` never rejects. The
 * `label` keeps the per-entrypoint log prefix Sentry already groups on.
 */
export function createTrackedThumbnailPublisher(label: string): {
  publisher: ThumbnailPublisher;
  drain: () => Promise<void>;
} {
  const inFlight = new Set<Promise<unknown>>();
  const publisher: ThumbnailPublisher = (eventId, ownerId, notify) => {
    const p = publishThumbnailUnique(eventId, ownerId, { notify })
      .catch(err =>
        console.error(`${label}: thumbnail publish failed:`, err instanceof Error ? err.message : String(err)),
      )
      .finally(() => {
        inFlight.delete(p);
      });
    inFlight.add(p);
  };
  const drain = async (): Promise<void> => {
    // Loop in case a publish is somehow enqueued mid-drain; in the cron
    // entrypoints nothing publishes after the sweep, so this settles once.
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  };
  return { publisher, drain };
}
