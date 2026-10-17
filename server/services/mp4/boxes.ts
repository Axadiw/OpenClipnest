import { Buffer } from 'buffer';

export interface BoxHeader {
  /** 4-char ASCII type */
  type: string;
  /** total box size including header */
  size: number;
  /** 8 or 16 (largesize) */
  headerSize: number;
}

export interface FullBoxVersion {
  version: number;
  flags: number;
}

export function readU64BE(buf: Buffer, off: number): number {
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return hi * 0x100000000 + lo;
}

export function readS32BE(buf: Buffer, off: number): number {
  return buf.readInt32BE(off);
}

export function readS64BE(buf: Buffer, off: number): number {
  const hi = buf.readInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return hi * 0x100000000 + lo;
}

export function readFlags(buf: Buffer, off: number): FullBoxVersion {
  const version = buf.readUInt8(off);
  const flags = (buf.readUInt8(off + 1) << 16) | (buf.readUInt8(off + 2) << 8) | buf.readUInt8(off + 3);
  return { version, flags };
}

/**
 * Read a single box header at `offset`. Returns `null` if the buffer doesn't
 * contain a complete header (8 bytes minimum, or 16 bytes for largesize).
 *
 * Special sizes:
 *   size === 0 → box extends to end-of-file
 *   size === 1 → 8-byte largesize follows the type field
 */
export function readBoxHeader(buf: Buffer, offset: number): BoxHeader | null {
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    const high = buf.readUInt32BE(offset + 8);
    const low = buf.readUInt32BE(offset + 12);
    size = high * 0x100000000 + low;
    headerSize = 16;
  }
  return { type, size, headerSize };
}

/**
 * Walk top-level boxes starting at `offset`. Returns array of (offset, header)
 * pairs. Stops at end of buffer or on malformed sizes.
 */
export function walkTopBoxes(
  buf: Buffer,
  startOffset = 0,
  bufferFileOffset = 0,
): { fileOffset: number; header: BoxHeader }[] {
  const out: { fileOffset: number; header: BoxHeader }[] = [];
  let off = startOffset;
  while (off < buf.length) {
    const h = readBoxHeader(buf, off);
    if (!h) break;
    if (h.size <= 0) break; // size==0 means extends-to-EOF; we stop here
    if (h.size > buf.length - off) {
      // Box extends past current buffer; record what we know but stop walking
      out.push({ fileOffset: bufferFileOffset + off, header: h });
      break;
    }
    out.push({ fileOffset: bufferFileOffset + off, header: h });
    off += h.size;
  }
  return out;
}

/**
 * Find a child box of given type within a container box's payload region
 * `[start, end)`. Returns null if not found.
 */
export function findChildBox(
  buf: Buffer,
  start: number,
  end: number,
  type: string,
): { offset: number; header: BoxHeader } | null {
  let off = start;
  while (off + 8 <= end) {
    const h = readBoxHeader(buf, off);
    if (!h || h.size <= 0) return null;
    if (h.type === type) return { offset: off, header: h };
    if (off + h.size > end) return null;
    off += h.size;
  }
  return null;
}

// Box-specific parser result interfaces

export interface MvhdInfo {
  version: 0 | 1;
  flags: number;
  timescale: number;
  duration: number;
}

export interface TkhdInfo {
  version: 0 | 1;
  flags: number;
  trackId: number;
  durationTicks: number;
}

export interface MdhdInfo {
  version: 0 | 1;
  flags: number;
  timescale: number;
  durationTicks: number;
}

export interface TrexInfo {
  trackId: number;
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
}

export interface TfhdInfo {
  trackId: number;
  /** raw 24-bit flags field (bottom 24 bits of the full-box version+flags word) */
  flags: number;
  /** `(flags & 0x000001) !== 0` — present iff tfhd carries an absolute base_data_offset */
  baseDataOffsetPresent: boolean;
  /** present iff flags & 0x000008 */
  defaultSampleDuration?: number;
  /** present iff flags & 0x000010 */
  defaultSampleSize?: number;
}

export interface TrunInfo {
  sampleCount: number;
  /** raw 24-bit flags */
  flags: number;
  /** `(flags & 0x000001) !== 0` */
  dataOffsetPresent: boolean;
  /** signed i32 — meaningful iff `dataOffsetPresent` */
  dataOffset: number;
  /** sum of per-sample durations if `hasSampleDurations`, else 0 */
  totalSampleDuration: number;
  /** TRUE if per-sample durations were present (flags & 0x000100) */
  hasSampleDurations: boolean;
}

export interface TfdtInfo {
  version: 0 | 1;
  flags: number;
  baseMediaDecodeTime: number;
}

export interface ElstEntry {
  segmentDuration: number;
  mediaTime: number;
  mediaRateInteger: number;
  mediaRateFraction: number;
}

export interface ElstInfo {
  version: 0 | 1;
  flags: number;
  entries: ElstEntry[];
}

export interface MehdInfo {
  version: 0 | 1;
  flags: number;
  fragmentDurationTicks: number;
}

// Box-specific parsers

export function parseMvhd(buf: Buffer, off: number, hdrSize: number): MvhdInfo {
  const p0 = off + hdrSize;
  const { version, flags } = readFlags(buf, p0);
  let p = p0 + 4;
  p += version === 1 ? 16 : 8; // creation + modification
  const timescale = buf.readUInt32BE(p);
  p += 4;
  const duration = version === 1 ? readU64BE(buf, p) : buf.readUInt32BE(p);
  return { version: version as 0 | 1, flags, timescale, duration };
}

export function parseTkhd(buf: Buffer, off: number, hdrSize: number): TkhdInfo {
  const p0 = off + hdrSize;
  const { version, flags } = readFlags(buf, p0);
  let p = p0 + 4;
  p += version === 1 ? 16 : 8; // creation + modification
  const trackId = buf.readUInt32BE(p);
  p += 4;
  p += 4; // reserved
  const durationTicks = version === 1 ? readU64BE(buf, p) : buf.readUInt32BE(p);
  return { version: version as 0 | 1, flags, trackId, durationTicks };
}

export function parseMdhd(buf: Buffer, off: number, hdrSize: number): MdhdInfo {
  const p0 = off + hdrSize;
  const { version, flags } = readFlags(buf, p0);
  let p = p0 + 4;
  p += version === 1 ? 16 : 8; // creation + modification
  const timescale = buf.readUInt32BE(p);
  p += 4;
  const durationTicks = version === 1 ? readU64BE(buf, p) : buf.readUInt32BE(p);
  return { version: version as 0 | 1, flags, timescale, durationTicks };
}

export function parseTrex(buf: Buffer, off: number, hdrSize: number): TrexInfo {
  const p = off + hdrSize + 4;
  return {
    trackId: buf.readUInt32BE(p),
    defaultSampleDescriptionIndex: buf.readUInt32BE(p + 4),
    defaultSampleDuration: buf.readUInt32BE(p + 8),
    defaultSampleSize: buf.readUInt32BE(p + 12),
    defaultSampleFlags: buf.readUInt32BE(p + 16),
  };
}

export function parseTfhd(buf: Buffer, off: number, hdrSize: number): TfhdInfo {
  // tfhd layout (full box):
  //   version(1) flags(3) track_id(4)
  //   [base_data_offset (8B) if flags & 0x000001]
  //   [sample_description_index (4B) if flags & 0x000002]
  //   [default_sample_duration (4B) if flags & 0x000008]
  //   [default_sample_size (4B) if flags & 0x000010]
  //   [default_sample_flags (4B) if flags & 0x000020]
  const { flags } = readFlags(buf, off + hdrSize);
  let p = off + hdrSize + 4;
  const trackId = buf.readUInt32BE(p);
  p += 4;
  const baseDataOffsetPresent = (flags & 0x000001) !== 0;
  if (baseDataOffsetPresent) p += 8;
  if (flags & 0x000002) p += 4;
  let defaultSampleDuration: number | undefined;
  let defaultSampleSize: number | undefined;
  if (flags & 0x000008) {
    defaultSampleDuration = buf.readUInt32BE(p);
    p += 4;
  }
  if (flags & 0x000010) {
    defaultSampleSize = buf.readUInt32BE(p);
  }
  return { trackId, flags, baseDataOffsetPresent, defaultSampleDuration, defaultSampleSize };
}

export function parseTrun(buf: Buffer, off: number, hdrSize: number): TrunInfo {
  // trun layout (full box):
  //   version(1) flags(3) sample_count(4)
  //   [data_offset (4B, signed) if flags & 0x000001]
  //   [first_sample_flags (4B) if flags & 0x000004]
  //   per-sample (variable):
  //     [sample_duration (4B) if flags & 0x000100]
  //     [sample_size (4B) if flags & 0x000200]
  //     [sample_flags (4B) if flags & 0x000400]
  //     [sample_composition_time_offset (4B) if flags & 0x000800]
  const { flags } = readFlags(buf, off + hdrSize);
  let p = off + hdrSize + 4;
  const sampleCount = buf.readUInt32BE(p);
  p += 4;
  const dataOffsetPresent = (flags & 0x000001) !== 0;
  let dataOffset = 0;
  if (dataOffsetPresent) {
    dataOffset = buf.readInt32BE(p);
    p += 4;
  }
  if (flags & 0x000004) p += 4;
  const hasSampleDurations = (flags & 0x000100) !== 0;
  const hasSampleSize = (flags & 0x000200) !== 0;
  const hasSampleFlags = (flags & 0x000400) !== 0;
  const hasCompTimeOffset = (flags & 0x000800) !== 0;
  let totalSampleDuration = 0;
  if (hasSampleDurations) {
    const stride =
      4 +
      (hasSampleSize ? 4 : 0) +
      (hasSampleFlags ? 4 : 0) +
      (hasCompTimeOffset ? 4 : 0);
    for (let i = 0; i < sampleCount; i++) {
      totalSampleDuration += buf.readUInt32BE(p);
      p += stride;
    }
  }
  return { sampleCount, flags, dataOffsetPresent, dataOffset, totalSampleDuration, hasSampleDurations };
}

export function parseTfdt(buf: Buffer, off: number, hdrSize: number): TfdtInfo {
  const { version, flags } = readFlags(buf, off + hdrSize);
  const p = off + hdrSize + 4;
  if (version === 1) {
    return { version: 1, flags, baseMediaDecodeTime: readU64BE(buf, p) };
  }
  return { version: 0, flags, baseMediaDecodeTime: buf.readUInt32BE(p) };
}

export function parseElst(buf: Buffer, off: number, hdrSize: number): ElstInfo {
  const p0 = off + hdrSize;
  const { version, flags } = readFlags(buf, p0);
  let p = p0 + 4;
  const entryCount = buf.readUInt32BE(p);
  p += 4;
  const entries: ElstEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    let segmentDuration: number;
    let mediaTime: number;
    if (version === 1) {
      segmentDuration = readU64BE(buf, p); p += 8;
      mediaTime = readS64BE(buf, p); p += 8;
    } else {
      segmentDuration = buf.readUInt32BE(p); p += 4;
      mediaTime = readS32BE(buf, p); p += 4;
    }
    const mediaRateInteger = buf.readInt16BE(p); p += 2;
    const mediaRateFraction = buf.readInt16BE(p); p += 2;
    entries.push({ segmentDuration, mediaTime, mediaRateInteger, mediaRateFraction });
  }
  return { version: version as 0 | 1, flags, entries };
}

export function parseMehd(buf: Buffer, off: number, hdrSize: number): MehdInfo {
  const p0 = off + hdrSize;
  const { version, flags } = readFlags(buf, p0);
  const p = p0 + 4;
  const fragmentDurationTicks = version === 1 ? readU64BE(buf, p) : buf.readUInt32BE(p);
  return { version: version as 0 | 1, flags, fragmentDurationTicks };
}
