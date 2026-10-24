import type { ByteRange } from '../byteRanges';
import { timeSegmentsForBytes, type SampleIndex } from '../mp4/sampleTable';
import type { Segment } from '../videoControls';

/**
 * The stretches of a recording whose bytes the service worker holds (fetched by playback or by
 * the hover preview), as 0..1 fractions of the bar. `[]` without an index or a usable duration.
 */
export function cachedFractionSegments(
  ix: SampleIndex | null, cached: readonly ByteRange[], duration: number,
): Segment[] {
  if (!ix || !Number.isFinite(duration) || duration <= 0) return [];
  const out: Segment[] = [];
  for (const s of timeSegmentsForBytes(ix, cached)) {
    const start = Math.min(1, Math.max(0, s.start / duration));
    const end = Math.min(1, Math.max(0, s.end / duration));
    if (end > start) out.push({ start, end });
  }
  return out;
}

/**
 * The worker's cached ranges, only when they describe the file the index was parsed from:
 * `total` must be known and equal `indexTotal` (a different size means another representation,
 * whose offsets the index does not describe). Ranges are clipped to the file; empty ones dropped.
 */
export function usableCachedRanges(
  ranges: readonly ByteRange[], total: number, indexTotal: number,
): ByteRange[] {
  if (!(total > 0) || total !== indexTotal) return [];
  const out: ByteRange[] = [];
  for (const r of ranges) {
    const start = Math.max(0, r.start);
    const end = Math.min(total, r.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}
