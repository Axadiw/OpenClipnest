import { Buffer } from 'buffer';
import { readBoxHeader } from './boxes.js';

// ---------------------------------------------------------------------------
// frameRate.ts — extract video frame rate from MP4 box data
//
// Two strategies, matching the two file classes in Clipnest:
//  - Class A (fragmented fMP4, Reolink): read trex.default_sample_duration
//    from the moov/mvex/trex chain — this is the fixed frame interval written
//    by the camera at encode time.
//  - Class B (classic MP4): read the stts (Sample-To-Time) box which encodes
//    per-run sample durations. The "dominant delta" (covering ≥90% of samples)
//    is used so a trailing oddly-sized frame doesn't throw off the calculation.
//
// Both functions return fps as a plain number or null:
//   null → fps could not be reliably determined; callers should treat this as
//          "unknown" and let the client fall back to 30 fps.
//
// fps > 240 is treated as a parser artefact and returned as null.
// ---------------------------------------------------------------------------

const MAX_FPS = 240;

// ---------------------------------------------------------------------------
// Box-walking helpers (minimal, avoids re-reading from boxes.ts which
// doesn't expose a findPath-style utility).
// ---------------------------------------------------------------------------

/**
 * Walk the direct children of a container box whose payload starts at
 * `payloadStart` and ends at `payloadEnd`. Returns the first child whose
 * type matches `targetType`, or null.
 */
function findChild(
  buf: Buffer,
  payloadStart: number,
  payloadEnd: number,
  targetType: string,
): { childPayloadStart: number; childPayloadEnd: number } | null {
  let pos = payloadStart;
  while (pos + 8 <= payloadEnd) {
    const hdr = readBoxHeader(buf, pos);
    if (!hdr || hdr.size <= 0) break;
    const childEnd = pos + hdr.size;
    if (hdr.type === targetType) {
      return {
        childPayloadStart: pos + hdr.headerSize,
        childPayloadEnd: Math.min(childEnd, payloadEnd, buf.length),
      };
    }
    pos += hdr.size;
  }
  return null;
}

/**
 * Follow a chain of box types from the root of `buf`, returning the payload
 * bounds of the innermost box, or null if any link in the chain is missing.
 *
 * `buf` must start with the outermost box header (e.g. a 'moov' box).
 */
function findPath(buf: Buffer, path: string[]): { start: number; end: number } | null {
  if (path.length === 0) return null;
  const rootHdr = readBoxHeader(buf, 0);
  if (!rootHdr || rootHdr.type !== path[0]) return null;
  let payStart = rootHdr.headerSize;
  let payEnd = Math.min(rootHdr.size, buf.length);
  for (let i = 1; i < path.length; i++) {
    const found = findChild(buf, payStart, payEnd, path[i]);
    if (!found) return null;
    payStart = found.childPayloadStart;
    payEnd = found.childPayloadEnd;
  }
  return { start: payStart, end: payEnd };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fragmented MP4: compute fps from mvex/trex default_sample_duration for the
 * given `trackId` and `timescale` (mdhd timescale for the video track).
 *
 * @param moovBuf  - Buffer containing the full moov box (starting at byte 0).
 * @param trackId  - tkhd track id of the primary (video) track.
 * @param timescale - mdhd timescale of the primary track (ticks per second).
 * @returns fps, or null if the trex is absent / defDur is 0 / fps > 240.
 */
export function frameRateFromTrex(
  moovBuf: Buffer,
  trackId: number,
  timescale: number,
): number | null {
  // Locate moov → mvex payload
  const mvexPayload = findPath(moovBuf, ['moov', 'mvex']);
  if (!mvexPayload) return null;

  // Walk mvex children looking for trex boxes that match trackId
  let pos = mvexPayload.start;
  while (pos + 8 <= mvexPayload.end) {
    const hdr = readBoxHeader(moovBuf, pos);
    if (!hdr || hdr.size <= 0) break;
    if (hdr.type === 'trex') {
      // trex full box payload layout (after box header):
      //   version(1) flags(3) = 4 bytes
      //   track_id(4)
      //   default_sample_description_index(4)
      //   default_sample_duration(4)   ← offset 12 from payload start
      //   default_sample_size(4)
      //   default_sample_flags(4)
      const payStart = pos + hdr.headerSize;
      if (payStart + 24 <= moovBuf.length) {
        const tId = moovBuf.readUInt32BE(payStart + 4);
        if (tId === trackId) {
          const defDur = moovBuf.readUInt32BE(payStart + 12);
          if (defDur <= 0) return null;
          const fps = timescale / defDur;
          if (fps > MAX_FPS) return null;
          return fps;
        }
      }
    }
    pos += hdr.size;
  }
  return null;
}

/**
 * Classic MP4: compute fps from a standalone stts box buffer.
 *
 * The stts box encodes runs of (sample_count, sample_delta) pairs. For CFR
 * (constant-frame-rate) video all samples share the same delta; for VFR there
 * can be many distinct deltas. We return fps only when one delta covers ≥90%
 * of total samples ("dominant delta"), treating the rest as CFR noise.
 *
 * @param sttsBox  - Buffer starting with the stts box header at offset 0.
 * @param timescale - mdhd timescale for the video track.
 * @returns fps, or null for VFR / empty / delta=0 / fps > 240.
 */
export function frameRateFromStts(sttsBox: Buffer, timescale: number): number | null {
  // Locate the stts payload
  const sttsHdr = readBoxHeader(sttsBox, 0);
  if (!sttsHdr || sttsHdr.type !== 'stts') return null;

  // stts full box payload:
  //   version(1) flags(3) = 4 bytes
  //   entry_count(4)
  //   [sample_count(4) sample_delta(4)] × entry_count
  const payStart = sttsHdr.headerSize;
  const entryCountOff = payStart + 4; // +4 for ver+flags
  if (entryCountOff + 4 > sttsBox.length) return null;
  const entryCount = sttsBox.readUInt32BE(entryCountOff);
  if (entryCount === 0) return null;

  const firstEntryOff = entryCountOff + 4;

  // Accumulate: delta → total sample count for that delta
  let totalSamples = 0;
  const deltaCounts = new Map<number, number>();
  for (let i = 0; i < entryCount; i++) {
    const base = firstEntryOff + i * 8;
    if (base + 8 > sttsBox.length) break;
    const sampleCount = sttsBox.readUInt32BE(base);
    const delta = sttsBox.readUInt32BE(base + 4);
    totalSamples += sampleCount;
    deltaCounts.set(delta, (deltaCounts.get(delta) ?? 0) + sampleCount);
  }

  if (totalSamples === 0) return null;

  // Find the delta that covers the most samples
  let dominantDelta = 0;
  let dominantCount = 0;
  for (const [delta, count] of deltaCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantDelta = delta;
    }
  }

  // Require ≥90% coverage to declare CFR
  if (dominantCount / totalSamples < 0.9) return null;
  if (dominantDelta <= 0) return null;

  const fps = timescale / dominantDelta;
  if (fps > MAX_FPS) return null;
  return fps;
}

/**
 * VFR-honest fps for a fragmented file: the average frame rate over the whole
 * clip. Unlike frameRateFromTrex (which trusts trex.default_sample_duration —
 * a nominal value the per-sample truns override, giving a ~10x overestimate on
 * Reolink VFR), this divides the real total sample count by the real duration.
 *
 * @returns fps, or null if undeterminable (no samples / non-positive duration)
 *          or fps > MAX_FPS (treated as a parser artefact).
 */
export function frameRateFromSampleCounts(
  totalSamples: number,
  totalDurationSeconds: number,
): number | null {
  if (totalSamples <= 0 || totalDurationSeconds <= 0) return null;
  const fps = totalSamples / totalDurationSeconds;
  if (fps > MAX_FPS) return null;
  return fps;
}
