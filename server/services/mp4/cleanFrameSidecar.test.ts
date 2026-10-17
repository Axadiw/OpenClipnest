import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import {
  CLEAN_FRAME_MAGIC,
  packCleanFrameSidecar,
  unpackCleanFrameSidecar,
} from './cleanFrameSidecar.js';

describe('CLEAN_FRAME_MAGIC', () => {
  it('has the stable value 0x636c6672 ("clfr")', () => {
    expect(CLEAN_FRAME_MAGIC).toBe(0x636c6672);
  });
});

describe('packCleanFrameSidecar / unpackCleanFrameSidecar', () => {
  it('round-trips all fields correctly', () => {
    const prelude = Buffer.from([0x66, 0x74, 0x79, 0x70]); // "ftyp"
    const mdatHeader = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74]); // 8-byte mdat header
    const byteRanges = [
      { srcOffset: 5_000_000_000, length: 100_000 }, // > 2^32 to exercise u64 path
      { srcOffset: 1024, length: 512 },
    ];
    const frameGrid = [0.0, 0.033333, 1.5, 10.123456789];

    const data = { prelude, mdatHeader, byteRanges, frameGrid };
    const packed = packCleanFrameSidecar(data);
    const unpacked = unpackCleanFrameSidecar(packed);

    expect(unpacked.prelude.equals(prelude)).toBe(true);
    expect(unpacked.mdatHeader.equals(mdatHeader)).toBe(true);
    expect(unpacked.byteRanges).toEqual(byteRanges);
    expect(unpacked.frameGrid).toEqual(frameGrid);
  });

  it('round-trips empty byteRanges and empty frameGrid to []', () => {
    const data = {
      prelude: Buffer.from([0xaa]),
      mdatHeader: Buffer.from([0xbb, 0xcc]),
      byteRanges: [],
      frameGrid: [],
    };
    const unpacked = unpackCleanFrameSidecar(packCleanFrameSidecar(data));
    expect(unpacked.byteRanges).toEqual([]);
    expect(unpacked.frameGrid).toEqual([]);
  });

  it('packed buffer starts with MAGIC bytes', () => {
    const packed = packCleanFrameSidecar({
      prelude: Buffer.from([0x01]),
      mdatHeader: Buffer.from([0x02]),
      byteRanges: [],
      frameGrid: [],
    });
    expect(packed.readUInt32BE(0)).toBe(CLEAN_FRAME_MAGIC);
  });

  it('throws on wrong magic (message mentions "magic")', () => {
    const bad = Buffer.alloc(8, 0x00);
    expect(() => unpackCleanFrameSidecar(bad)).toThrow(/magic/i);
  });

  it('throws Error (not RangeError) on bad magic', () => {
    const bad = Buffer.alloc(16, 0x00);
    bad.writeUInt32BE(0xdeadbeef, 0);
    expect(() => unpackCleanFrameSidecar(bad)).toThrow(/magic/i);
  });

  it('throws RangeError on truncated buffer (prelude region)', () => {
    // Build a valid-magic buffer but truncate before the prelude data ends
    const buf = Buffer.alloc(12, 0x00);
    buf.writeUInt32BE(CLEAN_FRAME_MAGIC, 0);
    buf.writeUInt32BE(1000, 4); // claims 1000-byte prelude
    // buf is only 12 bytes — truncated
    expect(() => unpackCleanFrameSidecar(buf)).toThrow(RangeError);
  });

  it('round-trips srcOffset > 2^32 without precision loss', () => {
    const data = {
      prelude: Buffer.from([0xff]),
      mdatHeader: Buffer.from([0xfe]),
      byteRanges: [
        { srcOffset: 4_294_967_296, length: 1 },   // exactly 2^32
        { srcOffset: 10_000_000_000, length: 999 }, // large
      ],
      frameGrid: [0.5, 1.0],
    };
    const unpacked = unpackCleanFrameSidecar(packCleanFrameSidecar(data));
    expect(unpacked.byteRanges).toEqual(data.byteRanges);
  });

  it('round-trips fractional frameGrid values', () => {
    const frameGrid = [0.0, 1 / 30, 2 / 30, 3 / 30];
    const data = {
      prelude: Buffer.from([0x00]),
      mdatHeader: Buffer.from([0x00]),
      byteRanges: [],
      frameGrid,
    };
    const unpacked = unpackCleanFrameSidecar(packCleanFrameSidecar(data));
    // float64 is exact for these values
    expect(unpacked.frameGrid).toEqual(frameGrid);
  });
});
