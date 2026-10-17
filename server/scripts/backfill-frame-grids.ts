#!/usr/bin/env node
/**
 * One-shot backfill: generate the two playback sidecars — `.frames` (web
 * fps-free grid, JSON) and `.clean_frame` (iOS frame-seekable recipe) — for
 * existing class-A recordings processed before these sidecars existed.
 *
 * New uploads already get both written by `fmp4PatchWorker` during the normal
 * sidecar-build pass. This script handles the historical backlog. Both are
 * built from a single original-recording fetch per row.
 *
 * Usage (inside the clipnest-api container, which has the required env vars):
 *
 *   npx tsx server/scripts/backfill-frame-grids.ts [--dry-run]
 *   DRY_RUN=true npx tsx server/scripts/backfill-frame-grids.ts
 *
 * With --dry-run (or DRY_RUN=true) the script logs what it WOULD write but
 * performs no S3 PUT operations.
 *
 * Idempotent / resumable: for each row the script HEADs `${s3Key}.frames` AND
 * `${s3Key}.clean_frame`; a row is skipped only when BOTH exist, and only the
 * missing sidecar(s) are (re)built. Re-running after a partial run resumes.
 *
 * NOT wired into any reconcile pass or cron — operator-run only.
 */

import type { Readable } from 'stream';
import { initDb } from '../db/index.js';
import { getClassAViewsAfter } from '../db/queries/events.js';
import { getObject, headObject, putObject } from '../services/s3.js';
import { buildFrameGridSidecar } from '../services/mp4/frameGridBuilder.js';
import { buildCleanFrameSidecar } from '../services/mp4/cleanFrameBuilder.js';
import type { RangeFetcher } from '../services/mp4/fragmentIndex.js';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Batch size per DB page. Matches the frame-rate backfill batch. */
const BATCH_SIZE = 200;

/** Head-window size — same 4 MiB as fmp4PatchWorker / backfillFrameRates. */
const HEAD_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export interface CursorLike {
  eventId: string;
  viewId: string;
}

/**
 * Advance the keyset cursor to the last row in a batch.
 * Returns null when the batch is empty (signals "no more pages").
 * Pure function — testable without DB/S3.
 */
export function nextCursor(rows: CursorLike[]): CursorLike | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { eventId: last.eventId, viewId: last.viewId };
}

/**
 * Decide the action for a single row given S3 HEAD result.
 * Returns 'skip' when the sidecar already exists, 'generate' otherwise.
 * Pure function — testable without S3.
 */
export function frameGridAction(framesExists: boolean): 'skip' | 'generate' {
  return framesExists ? 'skip' : 'generate';
}

// ---------------------------------------------------------------------------
// S3 helpers (mirroring fmp4PatchWorker / backfillFrameRates approach)
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += b.length;
    if (total > maxBytes) throw new Error(`stream exceeded maxBytes=${maxBytes}`);
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Per-row processor
// ---------------------------------------------------------------------------

async function sidecarExists(key: string, salt: string): Promise<boolean> {
  try {
    await headObject(CONFIG.s3SidecarsBucket, key, salt);
    return true;
  } catch {
    return false;
  }
}

async function processRow(
  row: { s3Key: string; encryptionSalt: string | null },
  dryRun: boolean,
): Promise<'skipped' | 'generated' | 'dry-run' | 'error'> {
  const salt = row.encryptionSalt ?? '';
  const framesKey = `${row.s3Key}.frames`;       // web fps-free grid (JSON)
  const cleanKey = `${row.s3Key}.clean_frame`;   // iOS frame-seekable recipe

  // CLEAN_FRAME_FORCE=true: always (re)build the .clean_frame sidecar even if it
  // already exists — needed to overwrite sidecars produced by an earlier buggy
  // builder. `.frames` is still HEAD-skipped (it was never affected).
  const forceClean = process.env.CLEAN_FRAME_FORCE === 'true';
  const [framesExists, cleanExists] = await Promise.all([
    sidecarExists(framesKey, salt),
    forceClean ? Promise.resolve(false) : sidecarExists(cleanKey, salt),
  ]);
  if (framesExists && cleanExists) return 'skipped';

  if (dryRun) {
    return 'dry-run';
  }

  // HEAD the recording to get its size.
  let fileSize: number;
  try {
    const { contentLength } = await headObject(CONFIG.s3RecordingsBucket, row.s3Key, salt);
    fileSize = contentLength;
  } catch (err) {
    throw new Error(
      `HEAD recording failed for ${row.s3Key}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Fetch head window once; both builders share it + the RangeFetcher.
  const headEnd = Math.min(HEAD_BYTES, fileSize) - 1;
  if (headEnd < 0) throw new Error(`recording has zero size: ${row.s3Key}`);

  const { body: headBody } = await getObject(
    CONFIG.s3RecordingsBucket,
    row.s3Key,
    salt,
    `bytes=0-${headEnd}`,
  );
  const headBuf = await streamToBuffer(headBody as Readable, HEAD_BYTES + 1024);

  // Build a RangeFetcher for moof boxes outside the head window.
  const fetchRange: RangeFetcher = async (start, end) => {
    const { body } = await getObject(
      CONFIG.s3RecordingsBucket,
      row.s3Key,
      salt,
      `bytes=${start}-${end}`,
    );
    return streamToBuffer(body as Readable, end - start + 1 + 1024);
  };

  let built = false;

  if (!framesExists) {
    const frameGridBuf = await buildFrameGridSidecar(headBuf, fileSize, fetchRange);
    if (frameGridBuf) {
      await putObject(CONFIG.s3SidecarsBucket, framesKey, frameGridBuf, salt, frameGridBuf.length);
      built = true;
    }
  }

  if (!cleanExists) {
    const cleanFrameBuf = (await buildCleanFrameSidecar(headBuf, fileSize, fetchRange))?.buf ?? null;
    if (cleanFrameBuf) {
      await putObject(CONFIG.s3SidecarsBucket, cleanKey, cleanFrameBuf, salt, cleanFrameBuf.length);
      built = true;
    }
  }

  // No parseable video track (both builders returned null) — skip silently;
  // web falls back to fps-based stepping, iOS to the fmp4patch path.
  return built ? 'generated' : 'skipped';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun =
    process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  if (dryRun) {
    console.log('[backfill-frame-grids] DRY RUN — no S3 writes will be performed');
  }

  await initDb();

  let cursor: { eventId: string; viewId: string } | null = null;
  let totalProcessed = 0;
  let totalGenerated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  console.log('[backfill-frame-grids] starting…');

  for (;;) {
    const rows = await getClassAViewsAfter(cursor, BATCH_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      totalProcessed++;
      try {
        const outcome = await processRow(row, dryRun);
        if (outcome === 'generated' || outcome === 'dry-run') {
          totalGenerated++;
          if (dryRun) {
            console.log(`[backfill-frame-grids] dry-run: would generate ${row.s3Key}.frames`);
          }
        } else {
          totalSkipped++;
        }
      } catch (err) {
        totalFailed++;
        console.error(
          `[backfill-frame-grids] FAILED ${row.s3Key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Progress heartbeat every 100 rows.
      if (totalProcessed % 100 === 0) {
        console.log(
          `[backfill-frame-grids] progress: ${totalProcessed} processed, ` +
          `${totalGenerated} ${dryRun ? 'would-generate' : 'generated'}, ` +
          `${totalSkipped} skipped, ${totalFailed} failed`,
        );
      }
    }

    cursor = nextCursor(rows);
  }

  console.log(
    `[backfill-frame-grids] done: ${totalProcessed} processed, ` +
    `${totalGenerated} ${dryRun ? 'would-generate' : 'generated'}, ` +
    `${totalSkipped} skipped, ${totalFailed} failed`,
  );

  if (totalFailed > 0) {
    // Non-zero exit so the operator knows to re-check; the next run retries
    // failed rows automatically (HEAD-skip ensures generated rows are not retried).
    process.exit(1);
  }
}

// Run only as a script — the unit tests import the pure helpers above.
if (process.argv[1] && /backfill-frame-grids\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stdout.write(`[backfill-frame-grids] FATAL: ${msg}\n`);
    process.exit(1);
  });
}
