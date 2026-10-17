import { Buffer } from 'buffer';

/** "clfr" — bump on any breaking format change. */
export const CLEAN_FRAME_MAGIC = 0x636c6672;

export interface CleanFrameByteRange {
  /** Absolute byte offset of this run of sample bytes in the ORIGINAL S3 file. */
  srcOffset: number;
  /** Number of sample bytes to copy. */
  length: number;
}

export interface CleanFrameSidecarData {
  /** ftyp + clean faststart moov; stco offsets already remapped to served-stream positions. */
  prelude: Buffer;
  /** The mdat box header bytes (8 or 16) for the single compacted mdat that follows the prelude. */
  mdatHeader: Buffer;
  /** Ordered runs of sample bytes to copy from the original into the compacted mdat (moof/free gaps excluded). */
  byteRanges: CleanFrameByteRange[];
  /** Video presentation times in SECONDS, sorted ascending (for the web fps-free stepper). */
  frameGrid: number[];
}

// ---------------------------------------------------------------------------
// Internal helpers — safe u64 read/write (values safe up to 2^53)
// ---------------------------------------------------------------------------

function writeU64BE(buf: Buffer, offset: number, value: number): void {
  const hi = Math.floor(value / 0x100000000);
  const lo = value >>> 0;
  buf.writeUInt32BE(hi, offset);
  buf.writeUInt32BE(lo, offset + 4);
}

function readU64BE(buf: Buffer, offset: number): number {
  const hi = buf.readUInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  return hi * 0x100000000 + lo;
}

// ---------------------------------------------------------------------------
// Binary format (big-endian throughout):
//
//   [u32 MAGIC = 0x636c6672]
//   [u32 prelude_len][prelude_len bytes: prelude]
//   [u32 mdat_header_len][mdat_header_len bytes: mdat header]
//   [u32 range_count][ range_count × ( u64 srcOffset (hi then lo), u32 length ) ]
//   [u32 grid_count][ grid_count × float64 ptsSeconds (writeDoubleBE) ]
// ---------------------------------------------------------------------------

export function packCleanFrameSidecar(data: CleanFrameSidecarData): Buffer {
  const { prelude, mdatHeader, byteRanges, frameGrid } = data;

  // 4 (magic)
  // + 4 (prelude_len) + prelude.length
  // + 4 (mdat_header_len) + mdatHeader.length
  // + 4 (range_count) + byteRanges.length × (8 srcOffset + 4 length)
  // + 4 (grid_count) + frameGrid.length × 8 (float64)
  const totalLen =
    4 +
    4 + prelude.length +
    4 + mdatHeader.length +
    4 + byteRanges.length * 12 +
    4 + frameGrid.length * 8;

  const buf = Buffer.allocUnsafe(totalLen);
  let pos = 0;

  buf.writeUInt32BE(CLEAN_FRAME_MAGIC, pos); pos += 4;

  buf.writeUInt32BE(prelude.length, pos); pos += 4;
  prelude.copy(buf, pos); pos += prelude.length;

  buf.writeUInt32BE(mdatHeader.length, pos); pos += 4;
  mdatHeader.copy(buf, pos); pos += mdatHeader.length;

  buf.writeUInt32BE(byteRanges.length, pos); pos += 4;
  for (const range of byteRanges) {
    writeU64BE(buf, pos, range.srcOffset); pos += 8;
    buf.writeUInt32BE(range.length, pos); pos += 4;
  }

  buf.writeUInt32BE(frameGrid.length, pos); pos += 4;
  for (const pts of frameGrid) {
    buf.writeDoubleBE(pts, pos); pos += 8;
  }

  return buf;
}

export function unpackCleanFrameSidecar(buf: Buffer): CleanFrameSidecarData {
  if (buf.length < 4) {
    throw new RangeError('cleanFrameSidecar: buffer too short (< 4 bytes)');
  }

  let pos = 0;

  const magic = buf.readUInt32BE(pos); pos += 4;
  if (magic !== CLEAN_FRAME_MAGIC) {
    throw new Error(
      `cleanFrameSidecar: bad magic 0x${magic.toString(16)} (expected 0x${CLEAN_FRAME_MAGIC.toString(16)})`,
    );
  }

  if (buf.length < pos + 4) {
    throw new RangeError('cleanFrameSidecar: buffer truncated before prelude_len');
  }
  const preludeLen = buf.readUInt32BE(pos); pos += 4;
  if (buf.length < pos + preludeLen) {
    throw new RangeError('cleanFrameSidecar: buffer truncated in prelude');
  }
  const prelude = Buffer.from(buf.subarray(pos, pos + preludeLen));
  pos += preludeLen;

  if (buf.length < pos + 4) {
    throw new RangeError('cleanFrameSidecar: buffer truncated before mdat_header_len');
  }
  const mdatHeaderLen = buf.readUInt32BE(pos); pos += 4;
  if (buf.length < pos + mdatHeaderLen) {
    throw new RangeError('cleanFrameSidecar: buffer truncated in mdatHeader');
  }
  const mdatHeader = Buffer.from(buf.subarray(pos, pos + mdatHeaderLen));
  pos += mdatHeaderLen;

  if (buf.length < pos + 4) {
    throw new RangeError('cleanFrameSidecar: buffer truncated before range_count');
  }
  const rangeCount = buf.readUInt32BE(pos); pos += 4;
  if (buf.length < pos + 12 * rangeCount) {
    throw new RangeError('cleanFrameSidecar: buffer truncated in byteRanges');
  }
  const byteRanges: CleanFrameByteRange[] = [];
  for (let i = 0; i < rangeCount; i++) {
    const srcOffset = readU64BE(buf, pos); pos += 8;
    const length = buf.readUInt32BE(pos); pos += 4;
    byteRanges.push({ srcOffset, length });
  }

  if (buf.length < pos + 4) {
    throw new RangeError('cleanFrameSidecar: buffer truncated before grid_count');
  }
  const gridCount = buf.readUInt32BE(pos); pos += 4;
  if (buf.length < pos + 8 * gridCount) {
    throw new RangeError('cleanFrameSidecar: buffer truncated in frameGrid');
  }
  const frameGrid: number[] = [];
  for (let i = 0; i < gridCount; i++) {
    frameGrid.push(buf.readDoubleBE(pos)); pos += 8;
  }

  return { prelude, mdatHeader, byteRanges, frameGrid };
}
