import { Buffer } from 'buffer';
import { readBoxHeader } from './boxes.js';
import type { FragmentRef } from './fragmentIndex.js';

// mfra: synthesized seek table

/**
 * Build a synthetic `mfra` box covering the given fragments. Layout:
 *
 *   mfra
 *     tfra × N_tracks (only primary track for our use case)
 *     mfro
 *
 * Each tfra entry uses version=1 (8-byte time + 8-byte moof_offset) so we
 * comfortably support files >4 GB. traf/trun/sample numbers are encoded as
 * 1 byte each (length_size_of_*=0 → +1 byte), values 1/1/1 since we point at
 * the first sample of the first traf in the moof (sufficient for seek).
 *
 * `moofFileOffsetShift` is added to each moof offset emitted in mfra, so the
 * caller can account for the patched-moov size delta (the sidecar is
 * [ftyp][moov+mehd][...moof+mdat (shifted)][mfra]).
 */
export function buildMfra(
  fragments: FragmentRef[],
  primaryTrackId: number,
  moofFileOffsetShift: number,
): Buffer {
  const tfraEntrySize = 8 + 8 + 1 + 1 + 1; // 19 bytes per entry (v1)
  const tfraBoxSize =
    8 + // box header
    1 + 3 + // version + flags
    4 + // track_id
    4 + // length_size_of_traf_num/trun_num/sample_num
    4 + // number_of_entry
    fragments.length * tfraEntrySize;
  const mfroBoxSize = 8 + 4 + 4; // header + version+flags + size
  const mfraBoxSize = 8 + tfraBoxSize + mfroBoxSize;

  const buf = Buffer.alloc(mfraBoxSize);
  let p = 0;

  // mfra header
  buf.writeUInt32BE(mfraBoxSize, p);
  buf.write('mfra', p + 4, 'ascii');
  p += 8;

  // tfra (one for primary track)
  buf.writeUInt32BE(tfraBoxSize, p);
  buf.write('tfra', p + 4, 'ascii');
  p += 8;
  buf.writeUInt8(1, p); // version=1
  // flags = 0 (bytes p+1..p+3 already zero)
  p += 4;
  buf.writeUInt32BE(primaryTrackId, p);
  p += 4;
  // length_size_of_traf_num=0 → 1 byte
  // length_size_of_trun_num=0 → 1 byte
  // length_size_of_sample_num=0 → 1 byte
  // (low 6 bits of last 4 bytes; all 0 → all 1-byte fields)
  buf.writeUInt32BE(0, p);
  p += 4;
  buf.writeUInt32BE(fragments.length, p);
  p += 4;

  for (const frag of fragments) {
    // time (8 bytes BE, primary-track timescale)
    const timeHi = Math.floor(frag.decodeTime / 0x100000000);
    const timeLo = frag.decodeTime >>> 0;
    buf.writeUInt32BE(timeHi, p);
    buf.writeUInt32BE(timeLo, p + 4);
    p += 8;
    // moof_offset (8 bytes BE, post-shift)
    const off = frag.moofFileOffset + moofFileOffsetShift;
    const offHi = Math.floor(off / 0x100000000);
    const offLo = off >>> 0;
    buf.writeUInt32BE(offHi, p);
    buf.writeUInt32BE(offLo, p + 4);
    p += 8;
    // traf_number=1, trun_number=1, sample_number=1 (each 1 byte)
    buf.writeUInt8(1, p);
    buf.writeUInt8(1, p + 1);
    buf.writeUInt8(1, p + 2);
    p += 3;
  }

  // mfro (movie fragment random access offset)
  buf.writeUInt32BE(mfroBoxSize, p);
  buf.write('mfro', p + 4, 'ascii');
  p += 8;
  // version=0, flags=0 (already zero)
  p += 4;
  buf.writeUInt32BE(mfraBoxSize, p);

  return buf;
}

// sidx: ISO BMFF Segment Index Box (DASH-style seek-table prepended to mp4)

/**
 * Parse the synthesized mfra produced by `buildMfra`. Returns the fragment
 * entries with their decode times and moof offsets (offsets are in whatever
 * coordinate space the mfra was built in — typically response-space after
 * `moofFileOffsetShift` was applied). Layout decoded:
 *
 *   bytes 0-7:    [u32 mfra_size][char[4] 'mfra']
 *   bytes 8-15:   [u32 tfra_size][char[4] 'tfra']
 *   bytes 16-31:  version(1) flags(3) track_id(4) length_size_flags(4) entry_count(4)
 *   bytes 32+:    entries × 19 bytes each: time(8) moof_offset(8) sample_info(3)
 *
 * Mirror of `buildMfra`'s writer. We rely on the exact layout that helper
 * emits (version=1, all length_size fields=0 → 1-byte each), not on a
 * generic mfra parser, so this only round-trips OUR sidecars.
 */
export function parseMfraEntries(mfra: Buffer): { decodeTime: number; moofOffset: number }[] {
  const mfraHdr = readBoxHeader(mfra, 0);
  if (!mfraHdr || mfraHdr.type !== 'mfra') {
    throw new Error('parseMfraEntries: missing mfra box');
  }
  const tfraHdr = readBoxHeader(mfra, 8);
  if (!tfraHdr || tfraHdr.type !== 'tfra') {
    throw new Error('parseMfraEntries: missing tfra box after mfra header');
  }
  const entryCount = mfra.readUInt32BE(28);
  const out: { decodeTime: number; moofOffset: number }[] = [];
  for (let i = 0; i < entryCount; i++) {
    const off = 32 + i * 19;
    const tHi = mfra.readUInt32BE(off);
    const tLo = mfra.readUInt32BE(off + 4);
    const oHi = mfra.readUInt32BE(off + 8);
    const oLo = mfra.readUInt32BE(off + 12);
    out.push({
      decodeTime: tHi * 0x100000000 + tLo,
      moofOffset: oHi * 0x100000000 + oLo,
    });
  }
  return out;
}

/**
 * Add `delta` to every `moof_offset` field inside the mfra produced by
 * `buildMfra`. Needed when we inject a `sidx` box between `moov` and the
 * first `moof` in the served response: every moof's byte position shifts
 * by `sidxLen`, and the trailing mfra's seek table must stay consistent so
 * iOS WebKit's mfra-driven seeks still land on the right moof.
 *
 * Returns a fresh copy; the input buffer is not mutated (the same sidecar
 * buffer is cached in-process by `sidecarCache` and reused across many
 * concurrent requests).
 */
export function shiftMfraOffsets(mfra: Buffer, delta: number): Buffer {
  if (delta === 0) return Buffer.from(mfra);
  const out = Buffer.from(mfra);
  const entryCount = out.readUInt32BE(28);
  for (let i = 0; i < entryCount; i++) {
    const off = 32 + i * 19;
    const oHi = out.readUInt32BE(off + 8);
    const oLo = out.readUInt32BE(off + 12);
    const newOff = oHi * 0x100000000 + oLo + delta;
    out.writeUInt32BE(Math.floor(newOff / 0x100000000), off + 8);
    out.writeUInt32BE(newOff >>> 0, off + 12);
  }
  return out;
}

/**
 * Predict the byte length of the sidx box `buildSidx` will emit for `count`
 * subsegments. Hoisted from the builder so the caller can pre-compute the
 * shift amount for `shiftMfraOffsets` and the response `Content-Length`
 * before actually generating sidx bytes.
 */
export function computeSidxSize(count: number): number {
  // box hdr (8) + version+flags (4) + reference_ID (4) + timescale (4)
  // + earliest_presentation_time (8 for v1) + first_offset (8 for v1)
  // + reserved (2) + reference_count (2) + N × reference (12 each).
  return 8 + 4 + 4 + 4 + 8 + 8 + 2 + 2 + count * 12;
}

/**
 * Build an ISO/IEC 14496-12 Segment Index Box (`sidx`) covering the given
 * subsegments. Placed in the served response between `moov` and the first
 * `moof`, sidx lets Chrome (and any MSE-aware browser) discover EVERY
 * fragment's offset+size+duration in one shot from the initial ~50KB read,
 * eliminating the moof-by-moof bisection that previously made cold playback
 * take 8-11s on Chrome (82 GETs / 9 MB / 10.8s vs Firefox's 3 GETs / 25 MB /
 * 0.35s on the same file).
 *
 * Layout (version 1 — 64-bit time/offset; required since Reolink clips can
 * exceed 4 GB):
 *
 *     [u32 size][char[4] 'sidx']
 *     [u8 version=1][u24 flags=0]
 *     [u32 reference_ID]                     ← primary track id
 *     [u32 timescale]                        ← primary-track mdhd timescale
 *     [u64 earliest_presentation_time]       ← 0 (we always start at t=0)
 *     [u64 first_offset]                     ← 0 (sidx is immediately followed by first moof)
 *     [u16 reserved=0][u16 reference_count]
 *     reference_count × [
 *       [u32: type_bit(1) | size(31)]        ← type=0 (movie fragment), size=moof+mdat bytes
 *       [u32 subsegment_duration]            ← in `timescale` ticks
 *       [u32: starts_with_SAP(1) | SAP_type(3) | SAP_delta(28)]
 *                                              0x90000000 = SAP at first sample, SAP_type=1
 *     ]
 *
 * `subsegment_size[i]` = `entries[i+1].moofOffset - entries[i].moofOffset`
 * (or `mdatZoneEnd - last.moofOffset` for the last subsegment).
 * `subsegment_duration[i]` = `entries[i+1].decodeTime - entries[i].decodeTime`
 * (or `totalDurationTicks - last.decodeTime` for the last subsegment).
 *
 * Note: this function does NOT shift offsets — the caller passes pre-shifted
 * values via `entries[].moofOffset`/`mdatZoneEnd`. Sidx itself uses
 * RELATIVE references (size deltas), so shift consistency only matters for
 * size computation, not for absolute positions encoded in sidx output.
 */
export function buildSidx(args: {
  entries: {
    decodeTime: number;
    moofOffset: number;
    /**
     * Optional per-fragment duration in `timescale` ticks. When provided,
     * used verbatim for `subsegment_duration[i]` instead of being derived
     * from the next entry's decodeTime delta. Multi-track Reolink clips
     * need this — primary-track decodeTime deltas don't match the audio
     * track's per-fragment wall-clock duration, so a primary-only sidx
     * for the audio track underflows real EOS by the time-base mismatch.
     * Single-track files can omit this and fall back to delta inference.
     */
    explicitDurationTicks?: number;
  }[];
  primaryTrackId: number;
  timescale: number;
  mdatZoneEnd: number;        // end-of-mdat in same coord space as entries[].moofOffset
  totalDurationTicks: number; // total clip duration in `timescale` units
  /**
   * Bytes between the END of this sidx box and the FIRST moof it indexes
   * (ISO/IEC 14496-12 §8.16.3 `first_offset`). Defaults to 0 — the right
   * value when this sidx is the LAST box before the indexed media. For
   * the dual-sidx layout (`[moov][sidx_v][sidx_a][moof...]`), the video
   * sidx must pass `firstOffset = sizeof(audio_sidx)` so the indexed
   * positions stay anchored to the first moof regardless of how many
   * sidx boxes precede it.
   */
  firstOffset?: number;
}): Buffer {
  const { entries, primaryTrackId, timescale, mdatZoneEnd, totalDurationTicks, firstOffset = 0 } = args;
  const N = entries.length;
  if (N === 0) throw new Error('buildSidx: no fragments');
  const size = computeSidxSize(N);
  const buf = Buffer.alloc(size);
  let p = 0;
  buf.writeUInt32BE(size, p); p += 4;
  buf.write('sidx', p, 'ascii'); p += 4;
  buf.writeUInt8(1, p); p += 1;             // version=1
  // flags=0 (next 3 bytes already zero from Buffer.alloc)
  p += 3;
  buf.writeUInt32BE(primaryTrackId, p); p += 4;
  buf.writeUInt32BE(timescale, p); p += 4;
  // earliest_presentation_time=0 (u64)
  p += 8;
  // first_offset (u64) — bytes between this sidx's end and the first
  // indexed media. 0 means "first moof is immediately after me". For
  // dual-sidx layouts the upstream sidx writes the downstream sidx's
  // byte length here so the downstream sidx gets skipped over.
  buf.writeUInt32BE(Math.floor(firstOffset / 0x100000000), p); p += 4;
  buf.writeUInt32BE(firstOffset >>> 0, p); p += 4;
  // reserved=0 (u16) — already zero
  p += 2;
  buf.writeUInt16BE(N, p); p += 2;

  for (let i = 0; i < N; i++) {
    const startOff = entries[i].moofOffset;
    const endOff = i + 1 < N ? entries[i + 1].moofOffset : mdatZoneEnd;
    const refSize = endOff - startOff;
    if (refSize <= 0) {
      throw new Error(`buildSidx: non-positive subsegment size at idx ${i}: ${refSize}`);
    }
    if (refSize >= 0x80000000) {
      throw new Error(`buildSidx: subsegment >2GiB at idx ${i} (would clobber type bit)`);
    }
    const explicitDur = entries[i].explicitDurationTicks;
    const dur = explicitDur !== undefined && explicitDur > 0
      ? explicitDur
      : (i + 1 < N ? entries[i + 1].decodeTime : totalDurationTicks) - entries[i].decodeTime;
    if (dur <= 0) {
      throw new Error(`buildSidx: non-positive subsegment duration at idx ${i}: ${dur}`);
    }
    // type bit (MSB) = 0 for movie-fragment subsegment; lower 31 bits = size.
    buf.writeUInt32BE(refSize >>> 0, p); p += 4;
    buf.writeUInt32BE(dur, p); p += 4;
    // starts_with_SAP(1)=1, SAP_type(3)=1 (closed GOP), SAP_delta_time(28)=0.
    buf.writeUInt32BE(0x90000000, p); p += 4;
  }
  return buf;
}
