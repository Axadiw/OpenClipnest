import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import type { RangeFetcher } from './fragmentIndex.js';
import { buildFrameGridSidecar } from './frameGridBuilder.js';

// ---------------------------------------------------------------------------
// Local box-building helpers (mirrors classicMoovBuilder.test.ts)
// ---------------------------------------------------------------------------

function box(type: string, payload: Buffer): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, 'ascii');
  payload.copy(buf, 8);
  return buf;
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const fb = Buffer.alloc(4 + payload.length);
  fb.writeUInt8(version, 0);
  fb.writeUInt8((flags >> 16) & 0xff, 1);
  fb.writeUInt8((flags >> 8) & 0xff, 2);
  fb.writeUInt8(flags & 0xff, 3);
  payload.copy(fb, 4);
  return box(type, fb);
}

function makeFtyp(): Buffer {
  const payload = Buffer.alloc(16);
  payload.write('isom', 0, 'ascii');
  payload.writeUInt32BE(0, 4);
  payload.write('isom', 8, 'ascii');
  payload.write('avc1', 12, 'ascii');
  return box('ftyp', payload);
}

function makeMvhd(timescale: number): Buffer {
  const payload = Buffer.alloc(96);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(0, 12);
  payload.writeUInt32BE(0x00010000, 16);
  payload.writeUInt16BE(0x0100, 20);
  payload.writeUInt32BE(0xffffffff, 92);
  return fullBox('mvhd', 0, 0, payload);
}

function makeTkhd(trackId: number): Buffer {
  const payload = Buffer.alloc(80);
  payload.writeUInt32BE(trackId, 8);
  return fullBox('tkhd', 0, 0, payload);
}

function makeMdhd(timescale: number): Buffer {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 8);
  return fullBox('mdhd', 0, 0, payload);
}

function makeHdlr(handlerType: string): Buffer {
  const payload = Buffer.alloc(4 + 4 + 12 + 1);
  payload.write(handlerType, 4, 'ascii');
  return fullBox('hdlr', 0, 0, payload);
}

function makeVmhd(): Buffer {
  return fullBox('vmhd', 0, 0x000001, Buffer.alloc(8));
}

function makeDinf(): Buffer {
  const url = fullBox('url ', 0, 0x000001, Buffer.alloc(0));
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(1, 0);
  const drefPayload = Buffer.concat([countBuf, url]);
  const dref = fullBox('dref', 0, 0, drefPayload);
  return box('dinf', dref);
}

function makeStsd(): Buffer {
  const avc1 = box('avc1', Buffer.alloc(78));
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(1, 0);
  const payload = Buffer.concat([countBuf, avc1]);
  return fullBox('stsd', 0, 0, payload);
}

/** Fragmented moov (with mvex+trex) — parseable by parseAllSamples. */
function makeMoov1Track(trackId: number, timescale: number): Buffer {
  const mvhd = makeMvhd(timescale);

  const tkhd = makeTkhd(trackId);
  const mdhd = makeMdhd(timescale);
  const hdlr = makeHdlr('vide');
  const vmhd = makeVmhd();
  const dinf = makeDinf();
  const stsd = makeStsd();
  const stbl = box('stbl', stsd);
  const minf = box('minf', Buffer.concat([vmhd, dinf, stbl]));
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  const trak = box('trak', Buffer.concat([tkhd, mdia]));

  const trexPayload = Buffer.alloc(20);
  trexPayload.writeUInt32BE(trackId, 0);
  trexPayload.writeUInt32BE(1, 4);
  const trex = fullBox('trex', 0, 0, trexPayload);
  const mvex = box('mvex', trex);

  return box('moov', Buffer.concat([mvhd, trak, mvex]));
}

/** Classic (non-fragmented) moov — no mvex, so parseAllSamples returns null. */
function makeClassicMoov1Track(trackId: number, timescale: number): Buffer {
  const mvhd = makeMvhd(timescale);
  const tkhd = makeTkhd(trackId);
  const mdhd = makeMdhd(timescale);
  const hdlr = makeHdlr('vide');
  const vmhd = makeVmhd();
  const dinf = makeDinf();
  const stsd = makeStsd();
  const stbl = box('stbl', stsd);
  const minf = box('minf', Buffer.concat([vmhd, dinf, stbl]));
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  const trak = box('trak', Buffer.concat([tkhd, mdia]));
  return box('moov', Buffer.concat([mvhd, trak]));
}

function makeExplicitMoofMdat(opts: {
  trackId: number;
  moofAbsOffset: number;
  decodeTime: number;
  sampleDurations: number[];
  sampleSizes: number[];
}): Buffer {
  const { trackId, moofAbsOffset, decodeTime, sampleDurations, sampleSizes } = opts;
  const N = sampleDurations.length;
  const perSample = 8; // duration(4) + size(4)
  const moofSize = 92 + N * perSample;
  const mdatPayloadStart = moofAbsOffset + moofSize + 8;

  const mfhd = fullBox('mfhd', 0, 0, Buffer.from([0, 0, 0, 1]));

  const tfhdPayload = Buffer.alloc(4 + 8);
  tfhdPayload.writeUInt32BE(trackId, 0);
  tfhdPayload.writeUInt32BE(Math.floor(mdatPayloadStart / 0x100000000), 4);
  tfhdPayload.writeUInt32BE(mdatPayloadStart >>> 0, 8);
  const tfhd = fullBox('tfhd', 0, 0x000001, tfhdPayload);

  const tfdtPayload = Buffer.alloc(4);
  tfdtPayload.writeUInt32BE(decodeTime, 0);
  const tfdt = fullBox('tfdt', 0, 0, tfdtPayload);

  const trunPayload = Buffer.alloc(4 + 4 + N * perSample);
  trunPayload.writeUInt32BE(N, 0);
  trunPayload.writeInt32BE(0, 4);
  for (let i = 0; i < N; i++) {
    trunPayload.writeUInt32BE(sampleDurations[i], 8 + i * perSample);
    trunPayload.writeUInt32BE(sampleSizes[i], 8 + i * perSample + 4);
  }
  const trun = fullBox('trun', 0, 0x000301, trunPayload);

  const traf = box('traf', Buffer.concat([tfhd, tfdt, trun]));
  const moof = box('moof', Buffer.concat([mfhd, traf]));
  if (moof.length !== moofSize) {
    throw new Error(`moof size mismatch: expected ${moofSize}, got ${moof.length}`);
  }

  const mdatPayloadSize = sampleSizes.reduce((a, b) => a + b, 0);
  const mdat = box('mdat', Buffer.alloc(mdatPayloadSize));
  return Buffer.concat([moof, mdat]);
}

function bufFetcher(file: Buffer): RangeFetcher {
  return async (start: number, end: number) =>
    Buffer.from(file.subarray(start, end + 1));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFrameGridSidecar', () => {
  it('returns a Buffer with a sorted ascending grid for a fragmented video file', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov1Track(trackId, timescale);
    const mediaStart = ftyp.length + moov.length;

    // 2 fragments × 3 samples
    const frag1 = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart,
      decodeTime: 0,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [100, 200, 300],
    });
    const frag2 = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart + frag1.length,
      decodeTime: 9000,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [150, 250, 350],
    });

    const file = Buffer.concat([ftyp, moov, frag1, frag2]);
    const result = await buildFrameGridSidecar(file, file.length, bufFetcher(file));

    expect(result).not.toBeNull();
    expect(Buffer.isBuffer(result)).toBe(true);

    const parsed = JSON.parse(result!.toString('utf8')) as { grid: number[] };
    expect(Array.isArray(parsed.grid)).toBe(true);

    // 6 total samples = 6 grid entries
    expect(parsed.grid.length).toBe(6);

    // All finite
    for (const t of parsed.grid) {
      expect(Number.isFinite(t)).toBe(true);
    }

    // Sorted ascending
    for (let i = 1; i < parsed.grid.length; i++) {
      expect(parsed.grid[i]).toBeGreaterThanOrEqual(parsed.grid[i - 1]);
    }
  });

  it('returns null for a non-fragmented (class B/C) file with no moof boxes', async () => {
    const ftyp = makeFtyp();
    const moov = makeClassicMoov1Track(1, 90000);
    const mdat = box('mdat', Buffer.alloc(64));
    const file = Buffer.concat([ftyp, moov, mdat]);

    const result = await buildFrameGridSidecar(file, file.length, bufFetcher(file));
    expect(result).toBeNull();
  });
});
