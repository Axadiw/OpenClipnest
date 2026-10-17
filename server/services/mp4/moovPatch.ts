import { Buffer } from 'buffer';
import { readBoxHeader, findChildBox } from './boxes.js';
import type { MoovInfo } from './moov.js';

// Patched moov: neutralise edts/elst (no size change)
//
// Historical note: this section also used to contain `writeDurationField`
// and a `U32_MAX` bounds-check constant, which together overwrote
// `mvhd.duration` / `tkhd.duration` / `mdhd.duration` with the fragment-
// derived total. Both were removed in the v4 schema bump after empirical
// iOS testing showed any non-zero declared duration triggers a 2× WebKit
// over-report on fragmented MP4 without `mehd` (see the long block comment
// on `patchMoovDurationsInPlace` below). Durations are now stored out-of-
// band in the sidecar binary's trailing `duration_ms` field.

/**
 * Neutralise a `trak/edts/elst` box by setting `entry_count = 0` — an
 * empty edit list, which spec-conformant parsers treat as "no edits, use
 * tkhd.duration / media samples directly". Total box size doesn't change;
 * any pre-existing entry bytes past the (now-zero) count become trailing
 * garbage that's never read.
 *
 * The `_segmentDuration` parameter is kept for backward compatibility with
 * the v3 schema's contract (which wrote a single matching-duration entry)
 * but is now ignored. See the long comment on `patchMoovDurationsInPlace`
 * for why we no longer want any per-trak duration declared.
 *
 * Why we don't just delete the elst: the edts/elst boxes have a fixed
 * size header and removing them would shrink moov, which would invalidate
 * every absolute `tfhd.base_data_offset` in the file's moofs. Zeroing
 * the entry count is the only no-shift neutralisation.
 */
export function patchElstInPlace(
  buf: Buffer,
  boxOffset: number,
  boxSize: number,
  boxHeaderSize: number,
  _segmentDuration: number,
): void {
  const payloadStart = boxOffset + boxHeaderSize;
  // elst layout: version(1) flags(3) entry_count(4) [entries...]
  const entryCountOff = payloadStart + 4;
  // Need at least the entry_count field itself in the box payload.
  if (entryCountOff + 4 > boxOffset + boxSize) return;
  buf.writeUInt32BE(0, entryCountOff);
}

/**
 * Historically this function patched the duration fields of mvhd, every
 * trak's tkhd, and every trak's mdia/mdhd to declare the actual fragment
 * duration in the moov, on the theory that this would let browsers fire
 * `loadedmetadata` quickly without scanning all fragments.
 *
 * **Empirically this turned out to be a disaster on iOS WebKit.** With our
 * sidecar layout — fragmented MP4 (`mvex` present) with no `mehd` — WebKit
 * implements the duration-of-presentation as
 *
 *     declared_duration + fragment_derived_duration
 *
 * where `declared_duration` is the first non-zero value it finds in
 * `mvhd.duration` / `tkhd.duration` / `mdhd.duration`, and
 * `fragment_derived_duration` is the sum of per-fragment durations parsed
 * from the moof/trun chain (or from `mfra` if we synthesise one). Both
 * land at ≈ real-clip-length, so WebKit reports ~2× the real duration —
 * a 1:29 clip displays as 2:58 and seeking past the real-time midpoint
 * lands beyond the mdat and the decoder freezes on the last good frame.
 * Desktop Chrome/Firefox happen to use only `declared_duration` when
 * non-zero, so they hide the bug.
 *
 * **The fix:** leave every header duration at 0 — the Reolink default
 * for fragmented files per ISO/IEC 14496-12 §8.30.2.1 ("if mvex present
 * and mehd absent, mvhd.duration should be 0"). With all zero, WebKit
 * has no declared value to double-count and falls back to the fragment-
 * derived total, which the synthesised `mfra` at the virtual file's
 * tail lets it compute in a single suffix-range fetch. Desktop browsers
 * compute the same value progressively as they parse moofs (visible
 * cosmetic glitch: timeline starts ~10s short and grows to the full
 * duration within the first few moofs — acceptable in exchange for a
 * non-broken iOS player).
 *
 * `mfra` provides the time→byte index iOS WebKit needs for precise
 * seeking; without it browsers estimate byte position proportionally
 * and land mid-mdat with no keyframe sync (the original "scrub past 50%
 * → stuck frame" symptom). So we still build the sidecar — the value is
 * the `mfra` tail, not the moov patches.
 *
 * **Why we still collapse `edts/elst`:** even though this particular
 * file has no elst, several Reolink firmwares emit redundant multi-
 * entry elst. WebKit's elst handling is independent of the duration-
 * sum bug above; if elst is present and longer than tkhd.duration (=0),
 * WebKit uses elst — which on a multi-entry layout can over- or under-
 * count. Collapsing to a single zero-rate empty edit (`entry_count=0`)
 * is the safest neutral state. See `patchElstInPlace` for details.
 *
 * Returns the input buffer unchanged in length so caller bookkeeping
 * (especially the assumption that `tfhd.base_data_offset` absolute
 * positions remain valid) stays intact.
 */
export function patchMoovDurationsInPlace(
  origMoov: Buffer,
  _moovInfo: MoovInfo,
  totalDurationSeconds: number,
): Buffer {
  if (origMoov.readUInt32BE(0) === 1) {
    throw new Error('patchMoovDurationsInPlace: moov uses largesize header (unsupported)');
  }
  if (totalDurationSeconds <= 0) return origMoov;

  const moovHdr = readBoxHeader(origMoov, 0);
  if (!moovHdr || moovHdr.type !== 'moov') {
    throw new Error('patchMoovDurationsInPlace: input is not a moov box');
  }
  const moovDataStart = moovHdr.headerSize;
  const moovDataEnd = origMoov.length;

  // Intentionally NOT patching mvhd.duration / tkhd.duration / mdhd.duration:
  // see the long block comment above this function for the iOS WebKit
  // double-counting failure mode that motivated the v4 schema bump.

  // Still walk every trak to collapse `edts/elst` if present — see
  // `patchElstInPlace` jsdoc. Most Reolink files don't have elst, so this
  // is a no-op on those.
  let p = moovDataStart;
  while (p + 8 <= moovDataEnd) {
    const h = readBoxHeader(origMoov, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      const trakDataStart = p + h.headerSize;
      const trakDataEnd = p + h.size;
      const edts = findChildBox(origMoov, trakDataStart, trakDataEnd, 'edts');
      if (edts) {
        const elst = findChildBox(
          origMoov,
          edts.offset + edts.header.headerSize,
          edts.offset + edts.header.size,
          'elst',
        );
        if (elst) {
          // Pass 0 — see updated patchElstInPlace contract: we now write
          // `entry_count = 0` (empty edit list) instead of injecting a
          // single matching segment, since matching tkhd.duration (now 0)
          // would either be a no-op or worse, a degenerate zero-segment
          // entry that some parsers reject.
          patchElstInPlace(
            origMoov,
            elst.offset,
            elst.header.size,
            elst.header.headerSize,
            0,
          );
        }
      }
    }
    p += h.size;
  }

  return origMoov;
}

/**
 * Patch `mvhd.duration` inside a prelude buffer (ftyp + moov) in-place.
 *
 * Chrome's `avformat_find_stream_info()` scans up to `analyzeduration` worth
 * of HEVC data before creating decoder streams when the total duration is
 * unknown (`mvhd.duration = 0`, no `mehd`). On a fast connection the probe
 * can exhaust the entire download buffer before playback starts, causing
 * `PIPELINE_ERROR_READ`. Writing `mvhd.duration` gives Chrome a known length
 * so it terminates the probe after reading the moov, not 30+ seconds of mdat.
 *
 * This is applied at serve time (not baked into the sidecar) using the
 * `durationMs` trailer stored in the v4 sidecar format. The prelude buffer
 * MUST be a writable copy — this function modifies it in-place.
 *
 * Known trade-off: iOS WebKit with `mvex` present and no `mehd` computes
 * presentation duration as `mvhd.duration + fragment_derived_total`, so a
 * non-zero `mvhd.duration` causes a 2× over-report. The proper fix (add
 * `mehd` + patch `tfhd.base_data_offset` at stream time) is planned; until
 * then Chrome correctness takes priority over iOS duration display accuracy.
 */
export function patchPreludeMvhdDuration(prelude: Buffer, durationMs: number): void {
  if (durationMs <= 0) return;

  const ftyp = readBoxHeader(prelude, 0);
  if (!ftyp || ftyp.type !== 'ftyp') return;

  const moovOffset = ftyp.size;
  const moovHdr = readBoxHeader(prelude, moovOffset);
  if (!moovHdr || moovHdr.type !== 'moov') return;

  // Walk direct moov children to find mvhd (always first child in practice).
  let off = moovOffset + moovHdr.headerSize;
  let mvhdOff = -1;
  let mvhdHdrSize = 0;
  while (off + 8 <= moovOffset + moovHdr.size) {
    const h = readBoxHeader(prelude, off);
    if (!h || h.size <= 0) break;
    if (h.type === 'mvhd') { mvhdOff = off; mvhdHdrSize = h.headerSize; break; }
    off += h.size;
  }
  if (mvhdOff < 0) return;

  // mvhd layout (version 0/1):
  //   version(1) flags(3)
  //   creation_time  (4 v0 | 8 v1)
  //   modification_time (4 v0 | 8 v1)
  //   timescale (4)
  //   duration  (4 v0 | 8 v1)
  const version = prelude.readUInt8(mvhdOff + mvhdHdrSize);
  const timescaleOff = mvhdOff + mvhdHdrSize + 4 + (version === 1 ? 16 : 8);
  const durationOff = timescaleOff + 4;

  const timescale = prelude.readUInt32BE(timescaleOff);
  if (timescale <= 0) return;

  const ticks = Math.round(durationMs / 1000 * timescale);
  if (ticks <= 0) return;

  if (version === 1) {
    prelude.writeUInt32BE(Math.floor(ticks / 0x100000000), durationOff);
    prelude.writeUInt32BE(ticks >>> 0, durationOff + 4);
  } else {
    prelude.writeUInt32BE(Math.min(ticks, 0xffffffff) >>> 0, durationOff);
  }
}

/**
 * Backwards-compat alias kept so external callers (and `buildSidecarForFile`
 * below) read naturally. Returns a NEW buffer (defensive copy) with the
 * durations patched in; original `origMoov` is left untouched. Same length
 * as input — see `patchMoovDurationsInPlace` for the layout invariant.
 *
 * Historically this function injected a 16-byte `mehd` box and grew the
 * moov by 16 bytes; that broke Reolink playback because every moof's
 * `tfhd.base_data_offset` is absolute and the +16 shift moved the actual
 * mdat data 16 bytes past where the offsets pointed. We now patch the
 * existing `mvhd`/`tkhd`/`mdhd` duration fields instead.
 */
export function buildPatchedMoov(
  origMoov: Buffer,
  moovInfo: MoovInfo,
  totalDurationSeconds: number,
): Buffer {
  const copy = Buffer.from(origMoov);
  return patchMoovDurationsInPlace(copy, moovInfo, totalDurationSeconds);
}
