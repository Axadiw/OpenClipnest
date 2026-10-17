import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { createCachingFetcher } from './cachingFetcher.js';
import { buildSidecarForFile } from './sidecarBuilder.js';
import { buildCleanFrameSidecar } from './cleanFrameBuilder.js';
import { buildFrameGridSidecar } from './frameGridBuilder.js';
import { SidecarParseCache } from './sidecarParseCache.js';
import type { RangeFetcher } from './fragmentIndex.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory RangeFetcher backed by a Buffer (inclusive [start, end]). */
function bufFetcher(file: Buffer): RangeFetcher {
  return async (start: number, end: number) =>
    Buffer.from(file.subarray(start, end + 1));
}

/** Spy RangeFetcher — delegates to inner and counts calls. */
function spyFetcher(inner: RangeFetcher): RangeFetcher & { callCount: number } {
  let callCount = 0;
  const spy = async (start: number, end: number): Promise<Buffer> => {
    callCount++;
    return inner(start, end);
  };
  Object.defineProperty(spy, 'callCount', {
    get: () => callCount,
  });
  return spy as RangeFetcher & { callCount: number };
}

// ---------------------------------------------------------------------------
// Minimal class-A mp4 fixture builders (mirrors classicMoovBuilder.test.ts)
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
  const drefPayload = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1, 0); return b; })(),
    url,
  ]);
  const dref = fullBox('dref', 0, 0, drefPayload);
  return box('dinf', dref);
}

function makeStsd(): Buffer {
  const avc1 = box('avc1', Buffer.alloc(78));
  const payload = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1, 0); return b; })(),
    avc1,
  ]);
  return fullBox('stsd', 0, 0, payload);
}

/** Fragmented moov (with mvex+trex) that the sidecar builders can read. */
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

/** moof+mdat with explicit per-sample sizes so offsets are deterministic. */
function makeExplicitMoofMdat(opts: {
  trackId: number;
  moofAbsOffset: number;
  decodeTime: number;
  sampleDurations: number[];
  sampleSizes: number[];
}): Buffer {
  const { trackId, moofAbsOffset, decodeTime, sampleDurations, sampleSizes } = opts;
  const N = sampleDurations.length;
  const moofSize = 92 + N * 8; // mfhd(12) + traf(8+tfhd(20)+tfdt(16)+trun(16+N*8))
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

  const trunPayload = Buffer.alloc(4 + 4 + N * 8);
  trunPayload.writeUInt32BE(N, 0);
  trunPayload.writeInt32BE(0, 4);
  let tp = 8;
  for (let i = 0; i < N; i++) {
    trunPayload.writeUInt32BE(sampleDurations[i], tp);
    trunPayload.writeUInt32BE(sampleSizes[i], tp + 4);
    tp += 8;
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

/** Build a minimal class-A file with N fragments (3 samples each). */
function buildClassAFile(fragmentCount: number): Buffer {
  const trackId = 1;
  const timescale = 90000;
  const ftyp = makeFtyp();
  const moov = makeMoov1Track(trackId, timescale);
  const mediaStart = ftyp.length + moov.length;

  const frags: Buffer[] = [];
  let off = mediaStart;
  let dt = 0;
  for (let i = 0; i < fragmentCount; i++) {
    const frag = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: off,
      decodeTime: dt,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [100 + i * 10, 200 + i * 10, 300 + i * 10],
    });
    frags.push(frag);
    off += frag.length;
    dt += 9000;
  }
  return Buffer.concat([ftyp, moov, ...frags]);
}

// ---------------------------------------------------------------------------
// Unit tests: createCachingFetcher slice correctness
// ---------------------------------------------------------------------------

describe('createCachingFetcher — slice correctness', () => {
  it('cache miss: returns bytes byte-identical to inner fetcher', async () => {
    const file = Buffer.from('abcdefghijklmnopqrstuvwxyz');
    const inner = bufFetcher(file);
    const cached = createCachingFetcher(inner);

    const got = await cached(3, 7);
    const expected = await inner(3, 7);
    expect(got).toEqual(expected);
    expect(got.toString('ascii')).toBe('defgh');
    expect(cached.stats().misses).toBe(1);
    expect(cached.stats().hits).toBe(0);
  });

  it('cache hit: returns byte-identical slice when a wider interval is cached', async () => {
    const file = Buffer.from('abcdefghijklmnopqrstuvwxyz');
    const inner = bufFetcher(file);
    const cached = createCachingFetcher(inner);

    // First fetch [0, 15] — populates cache.
    await cached(0, 15);
    expect(cached.stats().misses).toBe(1);
    expect(cached.stats().hits).toBe(0);

    // Second fetch [3, 7] — sub-interval of [0, 15], should hit cache.
    const got = await cached(3, 7);
    expect(cached.stats().hits).toBe(1);
    expect(cached.stats().misses).toBe(1); // no new miss

    const expected = await inner(3, 7);
    expect(got).toEqual(expected);
    expect(got.toString('ascii')).toBe('defgh');
    // Length must be exactly e - s + 1.
    expect(got.length).toBe(7 - 3 + 1);
  });

  it('cache hit at exact boundaries [s=cached.start, e=cached.end]', async () => {
    const file = Buffer.from('ABCDEFGHIJ');
    const inner = bufFetcher(file);
    const cached = createCachingFetcher(inner);

    await cached(2, 6); // populates [2,6]
    const got = await cached(2, 6); // exact match → hit
    expect(cached.stats().hits).toBe(1);
    expect(got.length).toBe(5);
    expect(got.toString('ascii')).toBe('CDEFG');
  });

  it('non-covering interval → cache miss (new fetch)', async () => {
    const file = Buffer.from('0123456789');
    const inner = bufFetcher(file);
    const cached = createCachingFetcher(inner);

    await cached(0, 4); // populates [0,4]
    const got = await cached(3, 7); // [3,7] not covered by [0,4] → miss
    expect(cached.stats().misses).toBe(2);
    expect(cached.stats().hits).toBe(0);
    expect(got.toString('ascii')).toBe('34567');
    expect(got.length).toBe(5);
  });

  it('stats.bytesFetched accumulates bytes from inner only (not from cache hits)', async () => {
    const file = Buffer.alloc(100, 0xaa);
    const inner = bufFetcher(file);
    const cached = createCachingFetcher(inner);

    await cached(0, 49);  // miss: 50 bytes fetched
    await cached(0, 49);  // hit: no new bytes
    await cached(5, 10);  // hit: no new bytes
    await cached(60, 79); // miss: 20 bytes fetched

    expect(cached.stats().bytesFetched).toBe(70);
    expect(cached.stats().hits).toBe(2);
    expect(cached.stats().misses).toBe(2);
  });

  it('single-byte intervals work correctly', async () => {
    const file = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]);
    const inner = bufFetcher(file);
    const cached = createCachingFetcher(inner);

    await cached(0, 4); // prime cache with full file
    const byte2 = await cached(2, 2); // single byte at index 2
    expect(byte2.length).toBe(1);
    expect(byte2[0]).toBe(0x30);
    expect(cached.stats().hits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration test: dedup proof — building both sidecars via cached fetcher
// issues strictly fewer inner calls than building them via a raw fetcher.
//
// Key insight: both builders only call fetchRange when fragment headers extend
// PAST the headBuf. To provably trigger fetchRange calls in tests, we pass a
// truncated headBuf (ftyp + moov only) and simulate the PATCH_HEAD_BYTES
// boundary — everything after the head goes through fetchRange. This is the
// exact scenario that occurs in production for large files.
// ---------------------------------------------------------------------------

describe('createCachingFetcher — sidecar double-build dedup', () => {
  it('cached fetcher issues strictly fewer S3 calls than raw for a multi-fragment file', async () => {
    // Build a 5-fragment class-A file.
    const file = buildClassAFile(5);

    // Simulate production: headBuf = ftyp + moov only (fragments past the head
    // must go through fetchRange). This guarantees fetchRange is called for
    // every moof in both builders.
    const ftyp = makeFtyp();
    const moov = makeMoov1Track(1, 90000);
    const headBuf = file.subarray(0, ftyp.length + moov.length);
    const inner = bufFetcher(file);

    // --- Baseline: raw (uncached) path — count calls from two independent spies ---
    const spy1 = spyFetcher(inner);
    const spy2 = spyFetcher(inner);
    await buildSidecarForFile(headBuf, file.length, spy1);
    await buildCleanFrameSidecar(headBuf, file.length, spy2);
    const rawTotal = spy1.callCount + spy2.callCount;

    // --- Optimised: cached path — SAME cached fetcher passed to both builders ---
    const spy3 = spyFetcher(inner);
    const cached = createCachingFetcher(spy3);
    await buildSidecarForFile(headBuf, file.length, cached);
    await buildCleanFrameSidecar(headBuf, file.length, cached);
    const cachedTotal = spy3.callCount; // only inner calls count

    // Both raw builders must have fetched at least once (sanity check).
    expect(rawTotal).toBeGreaterThan(0);

    // The cached path must make strictly fewer calls to the inner (S3) fetcher.
    expect(cachedTotal).toBeLessThan(rawTotal);

    // And cache must have recorded some hits (not zero — proves dedup happened).
    expect(cached.stats().hits).toBeGreaterThan(0);

    // Sanity: both paths must agree that the file is class A.
    const r1 = await buildSidecarForFile(headBuf, file.length, bufFetcher(file));
    expect(r1.classification.class).toBe('A');
    expect(r1.sidecar).not.toBeNull();
  });

  it('sidecar output is byte-identical whether built with raw or cached fetcher', async () => {
    const file = buildClassAFile(3);

    // Truncated headBuf to force fetchRange calls (same as production large-file path).
    const ftyp = makeFtyp();
    const moov = makeMoov1Track(1, 90000);
    const headBuf = file.subarray(0, ftyp.length + moov.length);
    const inner = bufFetcher(file);

    // Raw build
    const rawResult = await buildSidecarForFile(headBuf, file.length, inner);
    const rawClean = await buildCleanFrameSidecar(headBuf, file.length, inner);

    // Cached build
    const cached = createCachingFetcher(bufFetcher(file));
    const cachedResult = await buildSidecarForFile(headBuf, file.length, cached);
    const cachedClean = await buildCleanFrameSidecar(headBuf, file.length, cached);

    // .fmp4patch sidecars must be byte-identical.
    expect(cachedResult.sidecar).not.toBeNull();
    expect(rawResult.sidecar).not.toBeNull();
    expect(cachedResult.sidecar!.equals(rawResult.sidecar!)).toBe(true);

    // .clean_frame sidecars must be byte-identical.
    expect(cachedClean).not.toBeNull();
    expect(rawClean).not.toBeNull();
    expect(cachedClean!.buf.equals(rawClean!.buf)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SidecarParseCache (P4): the .clean_frame and .frames builders share ONE parse
// of the sample table, so the grid the web steps on and the table the iOS clean
// MP4 seeks on can never drift. The shared parse must NOT change output bytes.
// ---------------------------------------------------------------------------

describe('SidecarParseCache — single parse feeds both sidecar builders', () => {
  it('memoizes the parse — repeat getOrParse returns the same result', async () => {
    const file = buildClassAFile(3);
    const cache = new SidecarParseCache();
    const a = await cache.getOrParse(file, file.length, bufFetcher(file));
    const b = await cache.getOrParse(file, file.length, bufFetcher(file));
    expect(a).not.toBeNull();
    expect(b).toBe(a); // same object reference — parsed exactly once
  });

  it('clean_frame + frames bytes are identical with a shared cache vs independent parses', async () => {
    const file = buildClassAFile(4);
    // Truncated headBuf forces fetchRange (production large-file path).
    const headBuf = file.subarray(0, makeFtyp().length + makeMoov1Track(1, 90000).length);

    // Independent parses (no cache).
    const cleanA = await buildCleanFrameSidecar(headBuf, file.length, bufFetcher(file));
    const gridA = await buildFrameGridSidecar(headBuf, file.length, bufFetcher(file));

    // Shared cache (the worker's production path).
    const cache = new SidecarParseCache();
    const fetch = bufFetcher(file);
    const cleanB = await buildCleanFrameSidecar(headBuf, file.length, fetch, cache);
    const gridB = await buildFrameGridSidecar(headBuf, file.length, fetch, cache);

    expect(cleanA).not.toBeNull();
    expect(gridA).not.toBeNull();
    expect(cleanB!.buf.equals(cleanA!.buf)).toBe(true);
    expect(gridB!.equals(gridA!)).toBe(true);
  });
});
