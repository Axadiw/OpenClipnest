import { Buffer } from 'buffer';
import {
  readBoxHeader,
  findChildBox,
  readFlags,
  readU64BE,
  parseMvhd,
  parseTkhd,
  parseMdhd,
  type BoxHeader,
} from './boxes.js';
import type { RangeFetcher } from './fragmentIndex.js';
import { readHdlrType, fixAudioSampleDurations, fixVideoSampleDurations, AAC_FRAME_SAMPLES } from './audioStts.js';

// ---------------------------------------------------------------------------
// classicMoovBuilder — shared fragmented-MP4 parsing utilities. Parses the
// per-sample data carried in a fragmented MP4's moof/traf/trun boxes into
// per-track sample tables + media-region bounds (`parseAllSamples`), and
// synthesizes a *classic* (unfragmented) moov with full sample tables (stbl)
// from that data (`buildMoov`). No media bytes are moved — stco/co64 chunk
// offsets point straight at the sample bytes inside the original file's mdat.
//
// These are PURE functions over (head buffer, file size, range fetcher).
// They are consumed by the `.clean_frame` (cleanFrameBuilder) and `.frames`
// (frameGridBuilder) sidecar builders; this module owns no sidecar of its own.
// ---------------------------------------------------------------------------

/** bit 0x10000 of a sample's flags = sample_is_non_sync_sample */
const SAMPLE_FLAG_NON_SYNC = 0x10000;

export interface SampleInfo {
  /** absolute byte position of this sample in the original S3 file */
  absOffset: number;
  size: number;
  durationTicks: number;
  /** signed composition-time offset; 0 for most samples */
  compositionOffset: number;
  /** raw sample_flags; bit 0x10000 = non_sync_sample */
  flags: number;
}

export interface TrackData {
  trackId: number;
  /** mdhd timescale */
  timescale: number;
  /** verbatim stsd box copied from the original moov stbl */
  stsdBytes: Buffer;
  /** verbatim vmhd / smhd / nmhd box from the original moov minf */
  vmhdOrSmhd: Buffer;
  /** verbatim hdlr box from the original moov mdia */
  hdlrBytes: Buffer;
  /** verbatim dinf box from the original moov minf */
  dinfBytes: Buffer;
  /** verbatim mvhd-independent tkhd/mdhd carriers, kept for duration patching */
  tkhdBytes: Buffer;
  mdhdBytes: Buffer;
  samples: SampleInfo[];
  runs: Array<{ firstSampleAbsOffset: number; sampleCount: number }>;
}

export interface ParsedFragmentedFile {
  ftypBytes: Buffer;
  mvhdBytes: Buffer;
  mvhdInfo: ReturnType<typeof parseMvhd>;
  tracks: TrackData[];
  mediaStart: number;
  mediaEnd: number;
  moofOffsets: number[];
}

// ---------------------------------------------------------------------------
// Range fetch helper — fetch a box that may live past the head buffer. Reads a
// 16-byte header first to learn the size, then the full box.
// ---------------------------------------------------------------------------

async function fetchBox(
  fetchRange: RangeFetcher,
  absStart: number,
  fileSize: number,
): Promise<{ header: BoxHeader; buf: Buffer } | null> {
  const hdrEnd = Math.min(absStart + 16, fileSize);
  const hdrBuf = await fetchRange(absStart, hdrEnd - 1);
  const header = readBoxHeader(hdrBuf, 0);
  if (!header || header.size <= 0) return null;
  if (absStart + header.size > fileSize) return null;
  const buf = await fetchRange(absStart, absStart + header.size - 1);
  return { header, buf };
}

// Header-only variant — fetch just the 16 bytes needed to read a box's
// type + size, WITHOUT pulling the box payload. Used by the Step A discovery
// walk so it can enumerate moof offsets / find mfra without re-downloading
// every mdat (the whole media payload) from S3. The 16-byte read also primes
// the caching fetcher, so Step B's full-moof fetch hits cache for its own
// header probe.
async function fetchBoxHeader(
  fetchRange: RangeFetcher,
  absStart: number,
  fileSize: number,
): Promise<BoxHeader | null> {
  const hdrEnd = Math.min(absStart + 16, fileSize);
  const hdrBuf = await fetchRange(absStart, hdrEnd - 1);
  const header = readBoxHeader(hdrBuf, 0);
  if (!header || header.size <= 0) return null;
  return header;
}

// ---------------------------------------------------------------------------
// Box-building primitives
// ---------------------------------------------------------------------------

function box(type: string, payload: Buffer): Buffer {
  const buf = Buffer.allocUnsafe(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, 'ascii');
  payload.copy(buf, 8);
  return buf;
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const fb = Buffer.allocUnsafe(4 + payload.length);
  fb.writeUInt8(version, 0);
  fb.writeUInt8((flags >>> 16) & 0xff, 1);
  fb.writeUInt8((flags >>> 8) & 0xff, 2);
  fb.writeUInt8(flags & 0xff, 3);
  payload.copy(fb, 4);
  return box(type, fb);
}

function writeU64BE(buf: Buffer, off: number, value: number): void {
  const hi = Math.floor(value / 0x100000000);
  const lo = value >>> 0;
  buf.writeUInt32BE(hi, off);
  buf.writeUInt32BE(lo, off + 4);
}

// ---------------------------------------------------------------------------
// Step B — per-sample parse of a single moof box
// ---------------------------------------------------------------------------

/**
 * Parse one moof's traf/tfhd/trun and append the per-sample data to each
 * track's accumulator (creating it on first sight). `moofAbsStart` is the
 * moof box's absolute position in the original file. `buf`/`bufOffset` locate
 * the moof relative to a buffer (which may be a window slice).
 */
/**
 * Parse the moov/mvex/trex boxes into a per-track `default_sample_flags` map.
 * A trun/tfhd may omit per-sample and tfhd-default flags entirely, in which
 * case the sync state of every non-first sample is defined by the trex default.
 * trex payload: version+flags(4) track_id(4) def_sample_desc_idx(4)
 * def_sample_duration(4) def_sample_size(4) def_sample_flags(4).
 */
export function parseTrexDefaultFlags(
  buf: Buffer,
  moovOffset: number,
  moovHdr: BoxHeader,
): Map<number, number> {
  const out = new Map<number, number>();
  const mvex = findChildBox(buf, moovOffset + moovHdr.headerSize, moovOffset + moovHdr.size, 'mvex');
  if (!mvex) return out;
  let p = mvex.offset + mvex.header.headerSize;
  const end = Math.min(mvex.offset + mvex.header.size, buf.length);
  while (p + 8 <= end) {
    const h = readBoxHeader(buf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trex') {
      const pay = p + h.headerSize;
      if (pay + 24 <= buf.length) {
        out.set(buf.readUInt32BE(pay + 4), buf.readUInt32BE(pay + 20));
      }
    }
    p += h.size;
  }
  return out;
}

export function parseMoofSamples(
  buf: Buffer,
  moofOffsetInBuf: number,
  moofAbsStart: number,
  perTrackSamples: Map<number, SampleInfo[]>,
  perTrackRuns: Map<number, Array<{ firstSampleAbsOffset: number; sampleCount: number }>>,
  perTrackTrexFlags: Map<number, number> = new Map(),
): void {
  const moofHdr = readBoxHeader(buf, moofOffsetInBuf);
  if (!moofHdr || moofHdr.type !== 'moof') {
    throw new Error(`parseMoofSamples: expected moof, got ${moofHdr?.type}`);
  }
  const moofDataStart = moofOffsetInBuf + moofHdr.headerSize;
  const moofEnd = moofOffsetInBuf + moofHdr.size;

  // Walk traf children.
  let q = moofDataStart;
  while (q + 8 <= moofEnd) {
    const h = readBoxHeader(buf, q);
    if (!h || h.size <= 0) break;
    if (h.type === 'traf') {
      parseTraf(buf, q, h, moofAbsStart, perTrackSamples, perTrackRuns, perTrackTrexFlags);
    }
    q += h.size;
  }
}

function parseTraf(
  buf: Buffer,
  trafOffset: number,
  trafHdr: BoxHeader,
  moofAbsStart: number,
  perTrackSamples: Map<number, SampleInfo[]>,
  perTrackRuns: Map<number, Array<{ firstSampleAbsOffset: number; sampleCount: number }>>,
  perTrackTrexFlags: Map<number, number> = new Map(),
): void {
  const dataStart = trafOffset + trafHdr.headerSize;
  const dataEnd = trafOffset + trafHdr.size;

  const tfhdBox = findChildBox(buf, dataStart, dataEnd, 'tfhd');
  if (!tfhdBox) throw new Error('parseTraf: traf has no tfhd');

  // Parse tfhd fully (boxes.ts parseTfhd already decodes the common fields,
  // but we re-decode here to also pick up base_data_offset + default flags +
  // the 0x020000 default_base_is_moof modifier needed for base computation).
  const { flags: tfhdFlags } = readFlags(buf, tfhdBox.offset + tfhdBox.header.headerSize);
  let tp = tfhdBox.offset + tfhdBox.header.headerSize + 4;
  const trackId = buf.readUInt32BE(tp);
  tp += 4;

  // base_data_offset
  let base: number;
  if (tfhdFlags & 0x000001) {
    base = readU64BE(buf, tp);
    tp += 8;
  } else if (tfhdFlags & 0x020000) {
    // default_base_is_moof
    base = moofAbsStart;
  } else {
    base = moofAbsStart;
  }
  if (tfhdFlags & 0x000002) tp += 4; // sample_description_index
  let defaultSampleDuration = 0;
  let defaultSampleSize = 0;
  // Fall back to the trex (mvex) default_sample_flags when the tfhd doesn't
  // carry its own (flag 0x000020). Without this, a clip whose non-first samples
  // are marked non-sync ONLY by the trex default was parsed as flags=0 = "sync
  // sample" for every frame → stss marked EVERY sample a keyframe → AVFoundation
  // tried to decode P/B-frames as IDRs on any seek (-11821) in .clean_frame.
  let defaultSampleFlags = perTrackTrexFlags.get(trackId) ?? 0;
  if (tfhdFlags & 0x000008) {
    defaultSampleDuration = buf.readUInt32BE(tp);
    tp += 4;
  }
  if (tfhdFlags & 0x000010) {
    defaultSampleSize = buf.readUInt32BE(tp);
    tp += 4;
  }
  if (tfhdFlags & 0x000020) {
    defaultSampleFlags = buf.readUInt32BE(tp);
    // tp is not read past this point; no further advance needed.
  }

  let samples = perTrackSamples.get(trackId);
  if (!samples) {
    samples = [];
    perTrackSamples.set(trackId, samples);
  }
  let runs = perTrackRuns.get(trackId);
  if (!runs) {
    runs = [];
    perTrackRuns.set(trackId, runs);
  }

  // Walk trun children in order.
  let q = dataStart;
  while (q + 8 <= dataEnd) {
    const h = readBoxHeader(buf, q);
    if (!h || h.size <= 0) break;
    if (h.type === 'trun') {
      parseTrunSamples(
        buf,
        q,
        h,
        base,
        defaultSampleDuration,
        defaultSampleSize,
        defaultSampleFlags,
        samples,
        runs,
      );
    }
    q += h.size;
  }
}

function parseTrunSamples(
  buf: Buffer,
  trunOffset: number,
  trunHdr: BoxHeader,
  base: number,
  defaultSampleDuration: number,
  defaultSampleSize: number,
  defaultSampleFlags: number,
  samples: SampleInfo[],
  runs: Array<{ firstSampleAbsOffset: number; sampleCount: number }>,
): void {
  const { flags } = readFlags(buf, trunOffset + trunHdr.headerSize);
  let p = trunOffset + trunHdr.headerSize + 4;
  const sampleCount = buf.readUInt32BE(p);
  p += 4;

  let dataOffset = 0;
  if (flags & 0x000001) {
    dataOffset = buf.readInt32BE(p); // signed!
    p += 4;
  }
  let firstSampleFlags: number | undefined;
  if (flags & 0x000004) {
    firstSampleFlags = buf.readUInt32BE(p);
    p += 4;
  }

  const hasDur = (flags & 0x000100) !== 0;
  const hasSize = (flags & 0x000200) !== 0;
  const hasFlags = (flags & 0x000400) !== 0;
  const hasCto = (flags & 0x000800) !== 0;

  // Each run's first sample begins at base + dataOffset.
  let cursor = base + dataOffset;
  runs.push({ firstSampleAbsOffset: cursor, sampleCount });

  for (let i = 0; i < sampleCount; i++) {
    let dur = defaultSampleDuration;
    let size = defaultSampleSize;
    let sflags =
      i === 0 && firstSampleFlags !== undefined ? firstSampleFlags : defaultSampleFlags;
    let cto = 0;
    if (hasDur) {
      dur = buf.readUInt32BE(p);
      p += 4;
    }
    if (hasSize) {
      size = buf.readUInt32BE(p);
      p += 4;
    }
    if (hasFlags) {
      sflags = buf.readUInt32BE(p);
      p += 4;
    }
    if (hasCto) {
      // signed in ctts v1 semantics
      cto = buf.readInt32BE(p);
      p += 4;
    }
    samples.push({
      absOffset: cursor,
      size,
      durationTicks: dur,
      compositionOffset: cto,
      flags: sflags,
    });
    cursor += size;
  }
}

// ---------------------------------------------------------------------------
// Step C — extract per-track metadata (stsd / hdlr / vmhd|smhd / dinf /
// timescale) from the ORIGINAL moov
// ---------------------------------------------------------------------------

export interface OriginalTrackMeta {
  trackId: number;
  timescale: number;
  tkhdBytes: Buffer;
  mdhdBytes: Buffer;
  hdlrBytes: Buffer;
  vmhdOrSmhd: Buffer;
  dinfBytes: Buffer;
  stsdBytes: Buffer;
}

function copyBox(buf: Buffer, b: { offset: number; header: BoxHeader }): Buffer {
  return Buffer.from(buf.subarray(b.offset, b.offset + b.header.size));
}

/**
 * Walk the moov in `headBuf` and extract per-track metadata for every trak.
 * Returns a map keyed by track id. Throws on a structurally-incomplete trak.
 */
export function extractOriginalTrackMeta(
  headBuf: Buffer,
  moovOffset: number,
  moovHdr: BoxHeader,
): Map<number, OriginalTrackMeta> {
  const out = new Map<number, OriginalTrackMeta>();
  const dataStart = moovOffset + moovHdr.headerSize;
  const dataEnd = moovOffset + moovHdr.size;

  let p = dataStart;
  while (p + 8 <= dataEnd) {
    const h = readBoxHeader(headBuf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      const meta = extractTrakMeta(headBuf, p, h);
      out.set(meta.trackId, meta);
    }
    p += h.size;
  }
  return out;
}

function extractTrakMeta(headBuf: Buffer, trakOffset: number, trakHdr: BoxHeader): OriginalTrackMeta {
  const trakDataStart = trakOffset + trakHdr.headerSize;
  const trakDataEnd = trakOffset + trakHdr.size;

  const tkhdBox = findChildBox(headBuf, trakDataStart, trakDataEnd, 'tkhd');
  if (!tkhdBox) throw new Error('extractTrakMeta: trak has no tkhd');
  const trackId = parseTkhd(headBuf, tkhdBox.offset, tkhdBox.header.headerSize).trackId;

  const mdiaBox = findChildBox(headBuf, trakDataStart, trakDataEnd, 'mdia');
  if (!mdiaBox) throw new Error(`extractTrakMeta: trak ${trackId} has no mdia`);
  const mdiaStart = mdiaBox.offset + mdiaBox.header.headerSize;
  const mdiaEnd = mdiaBox.offset + mdiaBox.header.size;

  const mdhdBox = findChildBox(headBuf, mdiaStart, mdiaEnd, 'mdhd');
  if (!mdhdBox) throw new Error(`extractTrakMeta: trak ${trackId} has no mdhd`);
  const timescale = parseMdhd(headBuf, mdhdBox.offset, mdhdBox.header.headerSize).timescale;

  const hdlrBox = findChildBox(headBuf, mdiaStart, mdiaEnd, 'hdlr');
  if (!hdlrBox) throw new Error(`extractTrakMeta: trak ${trackId} has no hdlr`);

  const minfBox = findChildBox(headBuf, mdiaStart, mdiaEnd, 'minf');
  if (!minfBox) throw new Error(`extractTrakMeta: trak ${trackId} has no minf`);
  const minfStart = minfBox.offset + minfBox.header.headerSize;
  const minfEnd = minfBox.offset + minfBox.header.size;

  // media header: vmhd | smhd | nmhd (whichever is present)
  const mhd =
    findChildBox(headBuf, minfStart, minfEnd, 'vmhd') ??
    findChildBox(headBuf, minfStart, minfEnd, 'smhd') ??
    findChildBox(headBuf, minfStart, minfEnd, 'nmhd');
  if (!mhd) throw new Error(`extractTrakMeta: trak ${trackId} has no vmhd/smhd/nmhd`);

  const dinfBox = findChildBox(headBuf, minfStart, minfEnd, 'dinf');
  if (!dinfBox) throw new Error(`extractTrakMeta: trak ${trackId} has no dinf`);

  const stblBox = findChildBox(headBuf, minfStart, minfEnd, 'stbl');
  if (!stblBox) throw new Error(`extractTrakMeta: trak ${trackId} has no stbl`);
  const stblStart = stblBox.offset + stblBox.header.headerSize;
  const stblEnd = stblBox.offset + stblBox.header.size;
  const stsdBox = findChildBox(headBuf, stblStart, stblEnd, 'stsd');
  if (!stsdBox) throw new Error(`extractTrakMeta: trak ${trackId} has no stsd`);

  return {
    trackId,
    timescale,
    tkhdBytes: copyBox(headBuf, tkhdBox),
    mdhdBytes: copyBox(headBuf, mdhdBox),
    hdlrBytes: copyBox(headBuf, hdlrBox),
    vmhdOrSmhd: copyBox(headBuf, mhd),
    dinfBytes: copyBox(headBuf, dinfBox),
    stsdBytes: copyBox(headBuf, stsdBox),
  };
}

// ---------------------------------------------------------------------------
// Step D — synthesize stbl sub-boxes from sample data
// ---------------------------------------------------------------------------

export function buildStts(samples: SampleInfo[]): Buffer {
  // run-length encode durations
  const entries: Array<{ count: number; delta: number }> = [];
  for (const s of samples) {
    const last = entries[entries.length - 1];
    if (last && last.delta === s.durationTicks) {
      last.count += 1;
    } else {
      entries.push({ count: 1, delta: s.durationTicks });
    }
  }
  const payload = Buffer.allocUnsafe(4 + entries.length * 8);
  payload.writeUInt32BE(entries.length, 0);
  let p = 4;
  for (const e of entries) {
    payload.writeUInt32BE(e.count, p);
    payload.writeUInt32BE(e.delta, p + 4);
    p += 8;
  }
  return fullBox('stts', 0, 0, payload);
}

/** Returns null if no sample has a non-zero composition offset. */
export function buildCtts(samples: SampleInfo[]): Buffer | null {
  if (!samples.some((s) => s.compositionOffset !== 0)) return null;
  const entries: Array<{ count: number; offset: number }> = [];
  for (const s of samples) {
    const last = entries[entries.length - 1];
    if (last && last.offset === s.compositionOffset) {
      last.count += 1;
    } else {
      entries.push({ count: 1, offset: s.compositionOffset });
    }
  }
  const payload = Buffer.allocUnsafe(4 + entries.length * 8);
  payload.writeUInt32BE(entries.length, 0);
  let p = 4;
  for (const e of entries) {
    payload.writeUInt32BE(e.count, p);
    payload.writeInt32BE(e.offset, p + 4); // signed (version 1)
    p += 8;
  }
  return fullBox('ctts', 1, 0, payload);
}

export function buildStsz(samples: SampleInfo[]): Buffer {
  const payload = Buffer.allocUnsafe(8 + samples.length * 4);
  payload.writeUInt32BE(0, 0); // sample_size = 0 → per-sample sizes follow
  payload.writeUInt32BE(samples.length, 4);
  let p = 8;
  for (const s of samples) {
    payload.writeUInt32BE(s.size, p);
    p += 4;
  }
  return fullBox('stsz', 0, 0, payload);
}

export function buildStsc(runs: Array<{ firstSampleAbsOffset: number; sampleCount: number }>): Buffer {
  // One chunk per run. Compact consecutive runs with identical samples_per_chunk.
  const entries: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
  for (let i = 0; i < runs.length; i++) {
    const spc = runs[i].sampleCount;
    const last = entries[entries.length - 1];
    if (last && last.samplesPerChunk === spc) continue;
    entries.push({ firstChunk: i + 1, samplesPerChunk: spc });
  }
  const payload = Buffer.allocUnsafe(4 + entries.length * 12);
  payload.writeUInt32BE(entries.length, 0);
  let p = 4;
  for (const e of entries) {
    payload.writeUInt32BE(e.firstChunk, p);
    payload.writeUInt32BE(e.samplesPerChunk, p + 4);
    payload.writeUInt32BE(1, p + 8); // sample_description_index = 1
    p += 12;
  }
  return fullBox('stsc', 0, 0, payload);
}

/**
 * Build an stco (32-bit) or co64 (64-bit) box from a list of already-resolved
 * per-chunk byte offsets in the SERVED stream. The caller computes the offsets
 * — classic synthesis passes `firstSampleAbsOffset + offDelta` (samples stay in
 * place); the clean-frame builder passes the compacted served offset of each
 * chunk's first sample. `forceCo64` pins the box-type decision across both
 * two-pass rounds so the two preludes stay the same length.
 */
export function buildStcoOrCo64FromOffsets(offsets: number[], forceCo64: boolean): Buffer {
  // The stco-vs-co64 box type MUST be decided once (before pass 1) and stay
  // fixed across both passes, otherwise the two boxes differ in size and the
  // two-pass offset patching breaks. `forceCo64` carries that pre-decision.
  const needs64 = forceCo64 || offsets.some((o) => o >= 0x100000000);
  if (needs64) {
    const payload = Buffer.allocUnsafe(4 + offsets.length * 8);
    payload.writeUInt32BE(offsets.length, 0);
    let p = 4;
    for (const o of offsets) {
      writeU64BE(payload, p, o);
      p += 8;
    }
    return fullBox('co64', 0, 0, payload);
  }
  const payload = Buffer.allocUnsafe(4 + offsets.length * 4);
  payload.writeUInt32BE(offsets.length, 0);
  let p = 4;
  for (const o of offsets) {
    payload.writeUInt32BE(o, p);
    p += 4;
  }
  return fullBox('stco', 0, 0, payload);
}

/**
 * Returns null only when ALL samples are sync (the ISO default when stss is
 * absent). When ZERO samples are sync we MUST emit an stss with entry_count=0
 * — omitting it would mean "all samples are sync", which is the opposite. When
 * some-but-not-all are sync we list the 1-based sync sample indices.
 */
export function buildStss(samples: SampleInfo[]): Buffer | null {
  const syncNumbers: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (!(samples[i].flags & SAMPLE_FLAG_NON_SYNC)) {
      syncNumbers.push(i + 1); // 1-based
    }
  }
  // omit stss only when ALL are sync (the ISO default when stss is absent)
  if (syncNumbers.length === samples.length) return null;
  // zero sync samples → empty stss (DO NOT omit — absence means "all sync")
  // some sync, some not → stss with listed indices
  const payload = Buffer.allocUnsafe(4 + syncNumbers.length * 4);
  payload.writeUInt32BE(syncNumbers.length, 0);
  let p = 4;
  for (const n of syncNumbers) {
    payload.writeUInt32BE(n, p);
    p += 4;
  }
  return fullBox('stss', 0, 0, payload);
}

/**
 * Build an stbl from already-resolved per-chunk served offsets. `chunkOffsets`
 * has one entry per run (same order as `track.runs`). Shared by the classic and
 * clean-frame synthesis paths — only the chunk-offset computation differs.
 */
function buildStblFromOffsets(track: TrackData, chunkOffsets: number[], forceCo64: boolean): Buffer {
  const parts: Buffer[] = [track.stsdBytes, buildStts(track.samples)];
  const ctts = buildCtts(track.samples);
  if (ctts) parts.push(ctts);
  parts.push(buildStsc(track.runs));
  parts.push(buildStsz(track.samples));
  parts.push(buildStcoOrCo64FromOffsets(chunkOffsets, forceCo64));
  const stss = buildStss(track.samples);
  if (stss) parts.push(stss);
  return box('stbl', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// Duration patching helpers — rewrite the duration field of a copied
// mvhd/tkhd/mdhd box in place (returns a fresh patched copy).
// ---------------------------------------------------------------------------

function patchMvhdDuration(mvhdBytes: Buffer, durationTicks: number): Buffer {
  const out = Buffer.from(mvhdBytes);
  const hdr = readBoxHeader(out, 0)!;
  const { version } = readFlags(out, hdr.headerSize);
  // payload: ver+flags(4) creation modification timescale duration
  let p = hdr.headerSize + 4;
  p += version === 1 ? 16 : 8; // creation + modification
  p += 4; // timescale
  if (version === 1) writeU64BE(out, p, durationTicks);
  else out.writeUInt32BE(durationTicks >>> 0, p);
  return out;
}

function patchTkhdDuration(tkhdBytes: Buffer, durationTicks: number): Buffer {
  const out = Buffer.from(tkhdBytes);
  const hdr = readBoxHeader(out, 0)!;
  const { version } = readFlags(out, hdr.headerSize);
  // payload: ver+flags(4) creation modification track_id reserved(4) duration
  let p = hdr.headerSize + 4;
  p += version === 1 ? 16 : 8; // creation + modification
  p += 4; // track_id
  p += 4; // reserved
  if (version === 1) writeU64BE(out, p, durationTicks);
  else out.writeUInt32BE(durationTicks >>> 0, p);
  return out;
}

function patchMdhdDuration(mdhdBytes: Buffer, durationTicks: number): Buffer {
  const out = Buffer.from(mdhdBytes);
  const hdr = readBoxHeader(out, 0)!;
  const { version } = readFlags(out, hdr.headerSize);
  // payload: ver+flags(4) creation modification timescale duration
  let p = hdr.headerSize + 4;
  p += version === 1 ? 16 : 8; // creation + modification
  p += 4; // timescale
  if (version === 1) writeU64BE(out, p, durationTicks);
  else out.writeUInt32BE(durationTicks >>> 0, p);
  return out;
}

// ---------------------------------------------------------------------------
// Step E — synthesize the classic moov
// ---------------------------------------------------------------------------

/**
 * Generic moov synthesis shared by the classic and clean-frame builders. The
 * only difference between the two formats is the per-chunk byte offset written
 * into stco/co64: classic keeps every sample at its original file position
 * (`firstSampleAbsOffset + offDelta`); clean-frame compacts samples into one
 * mdat and points at their new served positions. `chunkOffsetsFor` resolves the
 * per-run offsets for one track (one entry per `track.runs`), given the
 * track whose sample durations have ALREADY had the audio-stts fix applied.
 */
export function buildMoov(
  originalMvhd: Buffer,
  tracks: TrackData[],
  mvhdTimescale: number,
  forceCo64: boolean,
  chunkOffsetsFor: (effectiveTrack: TrackData, trackIndex: number) => number[],
): Buffer {
  // Movie duration in mvhd timescale = max over tracks of
  // (sum of track sample durations in track ticks) / track.timescale * mvhdTimescale.
  // Apply the audio stts fix here too so mvhd.duration reflects corrected durations.
  let movieDurationTicks = 0;
  for (const t of tracks) {
    const isAudio = readHdlrType(t.hdlrBytes) === 'soun';
    const rawDurations = t.samples.map((s) => s.durationTicks);
    const fixedDurations = fixAudioSampleDurations(rawDurations, isAudio);
    const trackTicks = fixedDurations.reduce((acc, d) => acc + d, 0);
    if (t.timescale > 0) {
      const seconds = trackTicks / t.timescale;
      const inMovieTicks = Math.round(seconds * mvhdTimescale);
      if (inMovieTicks > movieDurationTicks) movieDurationTicks = inMovieTicks;
    }
  }

  const parts: Buffer[] = [patchMvhdDuration(originalMvhd, movieDurationTicks)];

  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const t = tracks[trackIndex];
    // Fix Reolink audio stts sample_delta=0: when all audio samples have
    // durationTicks=0 (Reolink firmware bug in fmp4 trun), substitute the
    // canonical AAC-LC frame size (1024 samples) so AVPlayer keeps the track.
    const isAudio = readHdlrType(t.hdlrBytes) === 'soun';
    const rawDurations = t.samples.map((s) => s.durationTicks);
    const fixedDurations = fixAudioSampleDurations(rawDurations, isAudio);
    const durationsWereFixed = fixedDurations !== rawDurations;
    // Build an effective copy of the track with corrected sample durations.
    const effectiveSamples: SampleInfo[] = durationsWereFixed
      ? t.samples.map((s, i) => ({ ...s, durationTicks: fixedDurations[i] }))
      : t.samples;
    const effectiveTrack: TrackData = durationsWereFixed
      ? { ...t, samples: effectiveSamples }
      : t;

    const trackTicks = effectiveSamples.reduce((acc, s) => acc + s.durationTicks, 0);
    // tkhd.duration is in MOVIE timescale; mdhd.duration is in TRACK timescale.
    const tkhdDurMovie =
      t.timescale > 0 ? Math.round((trackTicks / t.timescale) * mvhdTimescale) : 0;

    // When the audio fix was applied and all deltas were 0, the computed
    // trackTicks from moof/trun would be 0. Use totalSamples * AAC_FRAME_SAMPLES
    // directly (matches what buildStts will write) so mdhd.duration is consistent.
    const mdhdDurationTicks = durationsWereFixed
      ? effectiveSamples.length * AAC_FRAME_SAMPLES
      : trackTicks;

    const tkhd = patchTkhdDuration(t.tkhdBytes, tkhdDurMovie);
    const mdhd = patchMdhdDuration(t.mdhdBytes, mdhdDurationTicks);
    const chunkOffsets = chunkOffsetsFor(effectiveTrack, trackIndex);
    const stbl = buildStblFromOffsets(effectiveTrack, chunkOffsets, forceCo64);

    // minf = vmhd|smhd + dinf + stbl
    const minf = box('minf', Buffer.concat([t.vmhdOrSmhd, t.dinfBytes, stbl]));
    // mdia = mdhd + hdlr + minf
    const mdia = box('mdia', Buffer.concat([mdhd, t.hdlrBytes, minf]));
    // trak = tkhd + mdia (NO edts, NO mvex)
    const trak = box('trak', Buffer.concat([tkhd, mdia]));
    parts.push(trak);
  }

  return box('moov', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// parseAllSamples — Steps A–C: parse a fragmented MP4 head into per-track
// sample tables + media region bounds. Returns null for intentional give-ups
// (not fragmented / no moov / no moofs / no tracks). May throw on structural
// corruption (callers that want the classic null-on-any-error behavior wrap
// this in try/catch).
// ---------------------------------------------------------------------------

/**
 * Parse a fragmented MP4 head into per-track sample tables + media region
 * bounds. Returns null for the intentional give-ups (not fragmented / no moov /
 * no moofs / no tracks). May throw on structural corruption (callers that want
 * the classic null-on-any-error behavior wrap this in try/catch).
 */
export async function parseAllSamples(
  headBuf: Buffer,
  fileSize: number,
  fetchRange: RangeFetcher,
): Promise<ParsedFragmentedFile | null> {
  // Step A — locate ftyp + moov.
  const ftyp = readBoxHeader(headBuf, 0);
  if (!ftyp || ftyp.type !== 'ftyp' || ftyp.size <= 0) return null;
  const moovOffset = ftyp.size;
  const moovHdr = readBoxHeader(headBuf, moovOffset);
  if (!moovHdr || moovHdr.type !== 'moov' || moovHdr.size <= 0) return null;
  if (moovOffset + moovHdr.size > headBuf.length) return null;

  const ftypBytes = Buffer.from(headBuf.subarray(0, ftyp.size));

  const mvhdBox = findChildBox(
    headBuf,
    moovOffset + moovHdr.headerSize,
    moovOffset + moovHdr.size,
    'mvhd',
  );
  if (!mvhdBox) return null;
  const mvhdInfo = parseMvhd(headBuf, mvhdBox.offset, mvhdBox.header.headerSize);
  const mvhdBytes = copyBox(headBuf, mvhdBox);
  // Per-track trex default_sample_flags — the sync-flag fallback used when a
  // trun/tfhd doesn't carry its own (otherwise stss marks every frame a keyframe).
  const perTrackTrexFlags = parseTrexDefaultFlags(headBuf, moovOffset, moovHdr);

  const mediaStart = moovOffset + moovHdr.size;

  // Step A (cont.) — walk from mediaStart collecting moof positions and the
  // mediaEnd (first mfra, or file size). Boxes may live past headBuf.
  //
  // Discovery is HEADER-ONLY: we only need each box's type + size to record
  // moof offsets, spot the mfra, and advance the cursor. Fetching whole boxes
  // here — especially mdat, which is the entire media payload — would
  // re-download the full file from S3 on every sidecar build (the perf
  // regression this avoids). Step B below fetches the full moof bytes it
  // actually parses; it hits the cache primed by these 16-byte header reads.
  const moofOffsets: number[] = [];
  let mediaEnd = fileSize;
  let cursor = mediaStart;
  while (cursor < fileSize) {
    const header =
      cursor + 16 <= headBuf.length
        ? readBoxHeader(headBuf, cursor)
        : await fetchBoxHeader(fetchRange, cursor, fileSize);
    if (!header || header.size <= 0) break;

    if (header.type === 'mfra') {
      mediaEnd = cursor;
      break;
    }
    if (header.type === 'moof') {
      moofOffsets.push(cursor);
    }
    cursor += header.size;
  }

  if (moofOffsets.length === 0) {
    // No fragments → already a classic MP4 (class B/C). Nothing to do.
    return null;
  }

  // Step B — parse per-sample data from every moof.
  const perTrackSamples = new Map<number, SampleInfo[]>();
  const perTrackRuns = new Map<
    number,
    Array<{ firstSampleAbsOffset: number; sampleCount: number }>
  >();

  for (const moofAbs of moofOffsets) {
    let buf: Buffer;
    let offInBuf: number;
    if (moofAbs + 16 <= headBuf.length) {
      // Read header from headBuf to learn size; may still need a fetch.
      const h = readBoxHeader(headBuf, moofAbs);
      if (h && moofAbs + h.size <= headBuf.length) {
        buf = headBuf;
        offInBuf = moofAbs;
      } else {
        const fetched = await fetchBox(fetchRange, moofAbs, fileSize);
        if (!fetched) return null;
        buf = fetched.buf;
        offInBuf = 0;
      }
    } else {
      const fetched = await fetchBox(fetchRange, moofAbs, fileSize);
      if (!fetched) return null;
      buf = fetched.buf;
      offInBuf = 0;
    }
    parseMoofSamples(buf, offInBuf, moofAbs, perTrackSamples, perTrackRuns, perTrackTrexFlags);
  }

  // Step C — extract original track metadata.
  const originalMeta = extractOriginalTrackMeta(headBuf, moovOffset, moovHdr);

  // Assemble TrackData per track, preserving moov trak order.
  const tracks: TrackData[] = [];
  for (const [trackId, meta] of originalMeta) {
    const samples = perTrackSamples.get(trackId);
    const runs = perTrackRuns.get(trackId);
    if (!samples || !runs || samples.length === 0) {
      // A track present in moov but with no fragment samples — skip it
      // (Reolink always fragments every track, but be defensive).
      continue;
    }
    // Guard against the Reolink 32-bit underflow: a single video sample whose
    // trun sample_duration is a negative interval stored unsigned (≈ 2^32)
    // would otherwise inflate mvhd/stts AND the clean-frame grid (both derived
    // from these durations) to ~8 hours. Sanitize here, at the single source,
    // so every downstream consumer sees the corrected timeline.
    let finalSamples = samples;
    if (readHdlrType(meta.hdlrBytes) === 'vide') {
      const durs = samples.map((s) => s.durationTicks);
      const fixed = fixVideoSampleDurations(durs, true);
      if (fixed !== durs) {
        finalSamples = samples.map((s, i) => ({ ...s, durationTicks: fixed[i] }));
      }
    }
    tracks.push({
      trackId,
      timescale: meta.timescale,
      stsdBytes: meta.stsdBytes,
      vmhdOrSmhd: meta.vmhdOrSmhd,
      hdlrBytes: meta.hdlrBytes,
      dinfBytes: meta.dinfBytes,
      tkhdBytes: meta.tkhdBytes,
      mdhdBytes: meta.mdhdBytes,
      samples: finalSamples,
      runs,
    });
  }

  if (tracks.length === 0) return null;

  return { ftypBytes, mvhdBytes, mvhdInfo, tracks, mediaStart, mediaEnd, moofOffsets };
}
