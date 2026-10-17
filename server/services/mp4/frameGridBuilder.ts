import { Buffer } from 'buffer';
import { parseAllSamples } from './classicMoovBuilder.js';
import { buildFrameGrid } from './frameGrid.js';
import { readHdlrType } from './audioStts.js';
import type { RangeFetcher } from './fragmentIndex.js';
import type { SidecarParseCache } from './sidecarParseCache.js';

/**
 * Build the `.frames` sidecar: a JSON document `{"grid": number[]}` of the
 * video track's presentation times (seconds, sorted). Powers the web player's
 * fps-free frame stepping. Returns null for inputs with no parseable video
 * track / empty grid (caller skips writing the sidecar — the web falls back to
 * fps-based stepping).
 *
 * `cache` (optional): when the worker builds `.clean_frame` + `.frames` for the
 * same file it passes one SidecarParseCache so the sample table is parsed once —
 * the grid here is then guaranteed identical to the grid embedded in the clean
 * sidecar (single source of truth). Omitting it parses inline (tests / one-offs).
 */
export async function buildFrameGridSidecar(
  headBuf: Buffer,
  fileSize: number,
  fetchRange: RangeFetcher,
  cache?: SidecarParseCache,
): Promise<Buffer | null> {
  const parsed = cache
    ? await cache.getOrParse(headBuf, fileSize, fetchRange)
    : await parseAllSamples(headBuf, fileSize, fetchRange);
  if (!parsed) return null;
  const videoTrack = parsed.tracks.find((t) => readHdlrType(t.hdlrBytes) === 'vide');
  if (!videoTrack) return null;
  const grid = buildFrameGrid(
    videoTrack.samples.map((s) => ({ durationTicks: s.durationTicks, compositionOffset: s.compositionOffset })),
    videoTrack.timescale,
  );
  if (grid.length === 0) return null;
  // Round to 5 decimals (0.01 ms) to bound JSON size; precision is far finer
  // than any frame interval.
  const rounded = grid.map((t) => Math.round(t * 1e5) / 1e5);
  return Buffer.from(JSON.stringify({ grid: rounded }), 'utf8');
}
