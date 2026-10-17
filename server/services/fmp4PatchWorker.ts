/**
 * Worker glue between the pure box-level fmp4Patch module and the database
 * + S3 stack. Per-file ("file_metadata row") entrypoint:
 *
 *   - download head bytes (~4 MB) from the recordings bucket
 *   - classify the structure
 *   - if class A: index moof headers (with extra Range fetches if the file
 *     is bigger than the head buffer), build sidecar, PUT to sidecars bucket
 *   - if class B/C: mark ready immediately (no sidecar needed)
 *   - if class D/E: tombstone (processing_state='unplayable')
 *
 * Atomic increment of `file_metadata.processing_attempts` BEFORE any
 * S3 work; once over the budget, latch unplayable. The grid filters
 * tombstoned events out (events.playback_unplayable), so no extra user-
 * facing banner is needed — consistent with the 2026-04-29 decision to
 * retire `thumbnail_failed` notifications.
 */
import { Buffer } from 'buffer';
import type { Readable } from 'stream';
import { getObject, putObject } from './s3.js';
import { buildSidecarForFile } from './mp4/sidecarBuilder.js';
import { buildCleanFrameSidecar } from './mp4/cleanFrameBuilder.js';
import { buildFrameGridSidecar } from './mp4/frameGridBuilder.js';
import { parseSidecar, readDurationSecondsFromPrelude } from './mp4/sidecar.js';
import type { RangeFetcher } from './mp4/fragmentIndex.js';
import { createCachingFetcher } from './mp4/cachingFetcher.js';
import { SidecarParseCache } from './mp4/sidecarParseCache.js';
import {
  incrementPlaybackPatchAttempts,
  markPlaybackPatchReady,
  markPlaybackPatchUnplayable,
  getFileMetadataById,
  getPlaybackPatchState,
  setFileTruncated,
  type FileMetaRow,
} from '../db/queries/events.js';
import { CONFIG } from '../config.js';

/** Hard cap on attempts before tombstoning a poison-pill mp4. */
export const PATCH_RETRY_BUDGET = 5;

/**
 * Initial head fetch — covers ftyp + moov + several moof headers for a
 * typical Reolink fragmented mp4. Larger files require additional small
 * Range fetches walked sequentially through the moof chain.
 */
const PATCH_HEAD_BYTES = parseInt(
  process.env.PATCH_HEAD_BYTES || String(4 * 1024 * 1024),
  10,
);

/**
 * Drain a Readable into a Buffer. Bounded by `maxBytes` to avoid runaway
 * memory if a caller mistakenly passes an unranged GET.
 */
async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      throw new Error(`streamToBuffer: stream exceeded maxBytes=${maxBytes}`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

export type SidecarOutcome =
  | { result: 'generated'; sidecarBytes: number; durationSeconds: number; frameRate: number | null }
  | { result: 'skipped-already-good' }
  | { result: 'skipped-already-ready' }
  | { result: 'tombstoned'; reason: string }
  | { result: 'transient-error'; reason: string };

interface RunOptions {
  /** total file size in bytes; if unknown caller can pass null and we'll try a HEAD probe */
  fileSize: number;
  userSalt: string;
  /**
   * Optional pre-fetched head bytes (the first ~PATCH_HEAD_BYTES of the object).
   * When the thumbnail stage already downloaded the head to extract the frame,
   * it passes the buffer here so we skip a duplicate `bytes=0-4MB` GET per file
   * (head-fetch dedup). Used only when it covers the needed head range; otherwise
   * we fetch as usual.
   */
  preFetchedHead?: Buffer;
}

/**
 * Generate (or skip) the sidecar for one file_metadata row. Idempotent —
 * safe to call repeatedly; bails early if the row is already ready or
 * permanently tombstoned.
 */
export async function generateSidecarForFile(
  fileMetadataId: number,
  opts: RunOptions,
): Promise<SidecarOutcome> {
  const fm: FileMetaRow | null = await getFileMetadataById(fileMetadataId);
  if (!fm) return { result: 'transient-error', reason: 'file_metadata not found' };

  // Idempotency short-circuit: if already ready or permanently tombstoned,
  // bail out without bumping the attempts counter. This matters because
  // the same job can be re-enqueued (XCLAIM, scanner sweep) and we don't
  // want repeat calls to chip away at the retry budget for no reason.
  const state = await getPlaybackPatchState(fileMetadataId);
  if (state?.readyAt) return { result: 'skipped-already-ready' };
  if (state?.unplayable) {
    return {
      result: 'tombstoned',
      reason: 'already tombstoned (processing_state=unplayable)',
    };
  }

  const attempts = await incrementPlaybackPatchAttempts(fileMetadataId);
  if (attempts > PATCH_RETRY_BUDGET) {
    await markPlaybackPatchUnplayable(fileMetadataId);
    return {
      result: 'tombstoned',
      reason: `retry budget exhausted (${attempts}/${PATCH_RETRY_BUDGET})`,
    };
  }

  // Download head bytes. Bound by file size when smaller than the default.
  const headEnd = Math.min(PATCH_HEAD_BYTES, opts.fileSize) - 1;
  if (headEnd < 0) {
    await markPlaybackPatchUnplayable(fileMetadataId);
    return { result: 'tombstoned', reason: 'file is empty' };
  }

  // Head-fetch dedup: reuse the head the thumbnail stage already downloaded
  // when it covers the needed range; otherwise download it.
  let headBuf: Buffer;
  if (opts.preFetchedHead && opts.preFetchedHead.length >= headEnd + 1) {
    headBuf = opts.preFetchedHead;
  } else {
    try {
      const { body } = await getObject(
        fm.s3Bucket || CONFIG.s3RecordingsBucket,
        fm.s3Key,
        opts.userSalt,
        `bytes=0-${headEnd}`,
      );
      headBuf = await streamToBuffer(body as Readable, PATCH_HEAD_BYTES + 1024);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: 'transient-error',
        reason: `head fetch failed: ${msg.slice(0, 200)}`,
      };
    }
  }

  // Range fetcher used for fragments past the head buffer. The
  // buildSidecarForFile pipeline calls this lazily for big files.
  // Wrapped with a per-file interval cache so that the sequential builders
  // (buildSidecarForFile + buildCleanFrameSidecar + buildFrameGridSidecar)
  // share fetched moof buffers — reducing N×M S3 Range GETs to ~N.
  const rawFetchRange: RangeFetcher = async (start, end) => {
    const { body } = await getObject(
      fm.s3Bucket || CONFIG.s3RecordingsBucket,
      fm.s3Key,
      opts.userSalt,
      `bytes=${start}-${end}`,
    );
    return await streamToBuffer(body as Readable, end - start + 1 + 1024);
  };
  const fetchRange = createCachingFetcher(rawFetchRange);
  // Parse the moov+moof sample table ONCE; the .clean_frame and .frames builders
  // both derive from it, so the grid the web steps on and the sample table the
  // iOS clean MP4 seeks on are guaranteed identical (no drift).
  const parseCache = new SidecarParseCache();

  let result: Awaited<ReturnType<typeof buildSidecarForFile>>;
  try {
    result = await buildSidecarForFile(headBuf, opts.fileSize, fetchRange);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Permanent classification failure (malformed mp4) — tombstone now,
    // skip the rest of the budget.
    await markPlaybackPatchUnplayable(fileMetadataId);
    return { result: 'tombstoned', reason: `parse failed: ${msg.slice(0, 200)}` };
  }

  switch (result.classification.class) {
    case 'A': {
      // Build complete; PUT sidecar to dedicated bucket.
      const sidecarKey = `${fm.s3Key}.fmp4patch`;
      try {
        await putObject(
          CONFIG.s3SidecarsBucket,
          sidecarKey,
          result.sidecar!,
          opts.userSalt,
          result.sidecar!.length,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          result: 'transient-error',
          reason: `sidecar PUT failed: ${msg.slice(0, 200)}`,
        };
      }
      await markPlaybackPatchReady(fileMetadataId);

      // Build and store the .clean_frame sidecar — a tiny recipe (clean faststart
      // moov + sample-byte ranges into the original, ~tens of KB) that the serve
      // path stitches on-the-fly into a frame-seekable mp4 for iOS backward
      // frame-stepping. Non-fatal — iOS falls back to the fmp4 path.
      try {
        const cleanFrame = await buildCleanFrameSidecar(headBuf, opts.fileSize, fetchRange, parseCache);
        if (cleanFrame) {
          await putObject(
            CONFIG.s3SidecarsBucket,
            `${fm.s3Key}.clean_frame`,
            cleanFrame.buf,
            opts.userSalt,
            cleanFrame.buf.length,
          );
          // Authoritative truncation verdict. The FTPS-side flag only catches
          // the shape where the control channel dies first; the sample tables
          // catch every shape, including a data connection that closed early
          // while the session looked healthy. Writing it unconditionally also
          // CLEARS the flag when a re-upload finally lands the file in full.
          await setFileTruncated(fileMetadataId, cleanFrame.truncated);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fmp4PatchWorker] clean_frame build/PUT failed (non-fatal): ${msg.slice(0, 200)}`);
      }

      // Build and store the frame-grid sidecar (.frames). This is a small JSON
      // document {"grid": number[]} of the video track's presentation times,
      // used by the web player for fps-free frame stepping. Non-fatal — the
      // web player falls back to fps-based stepping if the sidecar is absent.
      try {
        const frameGridBuf = await buildFrameGridSidecar(headBuf, opts.fileSize, fetchRange, parseCache);
        if (frameGridBuf) {
          await putObject(
            CONFIG.s3SidecarsBucket,
            `${fm.s3Key}.frames`,
            frameGridBuf,
            opts.userSalt,
            frameGridBuf.length,
          );
        }
      } catch (err) {
        // Non-fatal — the web player falls back to fps-based stepping without it.
        console.warn(`[fmp4PatchWorker] frame-grid sidecar failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        result: 'generated',
        sidecarBytes: result.sidecar!.length,
        durationSeconds: result.totalDurationSeconds ?? 0,
        frameRate: result.frameRate ?? null,
      };
    }

    case 'B':
    case 'C': {
      // File is already playable as-is; just mark ready (no S3 write).
      await markPlaybackPatchReady(fileMetadataId);
      return { result: 'skipped-already-good' };
    }

    case 'D': {
      await markPlaybackPatchUnplayable(fileMetadataId);
      return {
        result: 'tombstoned',
        reason: result.classification.reason ?? 'unsupported container',
      };
    }

    case 'E':
    default: {
      await markPlaybackPatchUnplayable(fileMetadataId);
      return {
        result: 'tombstoned',
        reason: result.classification.reason ?? 'malformed mp4',
      };
    }
  }
}

/**
 * For a class-A file whose sidecar is already on S3
 * (processing_state = 'ready'), recover the playback duration in
 * seconds by parsing the patched mvhd inside the sidecar's prelude. The
 * sidecar is small (~5 KB) so this is one cheap GET — no fragment indexing,
 * no full-file download.
 *
 * Used by the thumbnail worker's sidecar stage and by the duration backfill
 * to write `events.duration` for files that were patched before duration was
 * persisted (or with the broken head-only ffmpeg estimate).
 *
 * Returns null if the sidecar is missing, malformed, or has no usable mvhd
 * duration. The caller should treat null as "leave the existing duration
 * alone" — never as a tombstone signal.
 */
export async function getDurationSecondsFromExistingSidecar(
  fileMetadataId: number,
  userSalt: string,
): Promise<number | null> {
  const fm = await getFileMetadataById(fileMetadataId);
  if (!fm) return null;
  const sidecarKey = `${fm.s3Key}.fmp4patch`;
  let buf: Buffer;
  try {
    const { body } = await getObject(CONFIG.s3SidecarsBucket, sidecarKey, userSalt);
    buf = await streamToBuffer(body as Readable, 1024 * 1024);
  } catch {
    return null;
  }
  try {
    const { prelude, durationMs } = parseSidecar(buf);
    // v4+ sidecars carry the canonical duration in a trailing u32 field, since
    // mvhd.duration is intentionally left at 0 to avoid the iOS WebKit 2×
    // over-report on fragmented MP4 (see fmp4Patch.ts patchMoovDurationsInPlace
    // jsdoc). Older v2/v3 sidecars omit the trailing field and we fall back
    // to scraping mvhd.
    if (typeof durationMs === 'number' && durationMs > 0) return durationMs / 1000;
    return readDurationSecondsFromPrelude(prelude);
  } catch {
    return null;
  }
}
