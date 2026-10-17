/**
 * Pure layout/range helpers for serving `.clean_frame` sidecars.
 *
 * The served MP4 layout is:
 *   [0, preludeLen)                    → prelude (ftyp + clean faststart moov)
 *   [preludeLen, preludeLen+mdatHeaderLen) → mdat box header (8 or 16 bytes)
 *   [preludeLen+mdatHeaderLen, servedSize) → compacted mdat payload
 *     (byteRanges concatenated; moof/free gaps between runs are excluded)
 */

import { Transform } from 'stream';

export interface CleanFrameLayout {
  preludeLen: number;
  mdatHeaderLen: number;
  servedSize: number;
}

/**
 * Compute the total served size and zone boundaries for a clean-frame response.
 */
export function cleanFrameLayout(
  preludeLen: number,
  mdatHeaderLen: number,
  byteRanges: { length: number }[],
): CleanFrameLayout {
  const payloadLen = byteRanges.reduce((acc, r) => acc + r.length, 0);
  return {
    preludeLen,
    mdatHeaderLen,
    servedSize: preludeLen + mdatHeaderLen + payloadLen,
  };
}

/**
 * Largest original-file byte offset (EXCLUSIVE end) referenced by any run.
 *
 * If this exceeds the CURRENT original object's size, the sidecar was built
 * against a different (older / larger) original — serving it would Range-GET
 * out-of-bounds bytes from S3 and reset the stream mid-body. That reset is
 * exactly the nginx "upstream prematurely closed connection" → 502 the client
 * sees as "can't play the last ~2 s" while a file is being reprocessed.
 *
 * Callers compare this against the live `fileSize` to detect a stale sidecar
 * and return a retryable 503 (let the reconciler rebuild) instead of serving a
 * corrupt tail.
 */
export function cleanFrameMaxSrcEnd(byteRanges: { srcOffset: number; length: number }[]): number {
  let max = 0;
  for (const r of byteRanges) {
    const end = r.srcOffset + r.length;
    if (end > max) max = end;
  }
  return max;
}

/**
 * For a requested payload range [payloadStart, payloadEnd] (0-based offsets
 * within the COMPACTED mdat payload — i.e. relative to the first byte after
 * the mdat header), return the original-file sub-ranges to fetch IN ORDER.
 * Each `{origStart, origEnd}` is inclusive. Concatenating the bytes for each
 * sub-range yields exactly the requested payload bytes.
 *
 * Gaps between runs in the original file are excluded from the payload (they
 * were stripped when the sidecar was built), so a payload offset maps to a
 * non-contiguous original offset.
 */
export function payloadRangeToOriginalRanges(
  byteRanges: { srcOffset: number; length: number }[],
  payloadStart: number,
  payloadEnd: number,
): { origStart: number; origEnd: number }[] {
  const result: { origStart: number; origEnd: number }[] = [];
  let runPayloadStart = 0; // start of this run in payload-space (0-based)

  for (const run of byteRanges) {
    const runPayloadEnd = runPayloadStart + run.length - 1; // inclusive

    // Does this run overlap with [payloadStart, payloadEnd]?
    const overlapStart = Math.max(payloadStart, runPayloadStart);
    const overlapEnd = Math.min(payloadEnd, runPayloadEnd);

    if (overlapStart <= overlapEnd) {
      // Convert overlap endpoints from payload-space to original-file-space.
      const origStart = run.srcOffset + (overlapStart - runPayloadStart);
      const origEnd = run.srcOffset + (overlapEnd - runPayloadStart);
      result.push({ origStart, origEnd });
    }

    runPayloadStart += run.length;

    // Early exit: we've passed the requested range.
    if (runPayloadStart > payloadEnd) break;
  }

  return result;
}

export interface CoalescedSpan {
  spanStart: number; // inclusive original byte offset to GET
  spanEnd: number;   // inclusive
  keep: { offset: number; length: number }[]; // span-relative segments to emit, in order
}

/**
 * Collapse ascending, non-overlapping original ranges into ONE span to fetch
 * plus the span-relative "keep" segments (the gaps between runs are dropped).
 * Returns null for an empty input.
 */
export function coalesceOriginalRanges(
  origRanges: { origStart: number; origEnd: number }[],
): CoalescedSpan | null {
  if (origRanges.length === 0) return null;
  const spanStart = origRanges[0].origStart;
  const spanEnd = origRanges[origRanges.length - 1].origEnd;
  const keep = origRanges.map((r) => ({
    offset: r.origStart - spanStart,
    length: r.origEnd - r.origStart + 1,
  }));
  return { spanStart, spanEnd, keep };
}

/**
 * Transform stream that receives the bytes of a single spanning S3 GET
 * (covering [spanStart, spanEnd]) and emits ONLY the "keep" segments,
 * dropping the gap bytes in between. Handles segments that straddle chunk
 * boundaries so the stream stays fully incremental (no buffering).
 */
export function createGapSkipTransform(keep: { offset: number; length: number }[]): Transform {
  let pos = 0;  // span-relative offset of the next incoming byte
  let ki = 0;   // index into keep (sorted, non-overlapping)
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const chunkStart = pos;
      const chunkEnd = pos + chunk.length; // exclusive
      while (ki < keep.length) {
        const segStart = keep[ki].offset;
        const segEnd = segStart + keep[ki].length; // exclusive
        if (segEnd <= chunkStart) { ki++; continue; }  // segment entirely before this chunk
        if (segStart >= chunkEnd) break;               // segment starts after this chunk
        const from = Math.max(segStart, chunkStart) - chunkStart;
        const to = Math.min(segEnd, chunkEnd) - chunkStart;
        if (to > from) this.push(chunk.subarray(from, to));
        if (segEnd <= chunkEnd) ki++; else break;      // segment continues into next chunk
      }
      pos = chunkEnd;
      cb();
    },
  });
}
