import { describe, it, expect } from 'vitest';
import { story } from '../../testing/story.js';
import { Buffer } from 'buffer';
import { readBoxHeader, findChildBox } from './boxes.js';
import { unpackCleanFrameSidecar } from './cleanFrameSidecar.js';
import { buildCleanFrameSidecar } from './cleanFrameBuilder.js';
import type { RangeFetcher } from './fragmentIndex.js';

// ---------------------------------------------------------------------------
// Local box-building helpers — same minimal structurally-complete moov the
// classicMoovBuilder test owns (the builder reads stsd/hdlr/vmhd/dinf out of
// the original moov).
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
  payload.writeUInt32BE(0, 12); // duration (patched by builder)
  payload.writeUInt32BE(0x00010000, 16); // rate
  payload.writeUInt16BE(0x0100, 20); // volume
  payload.writeUInt32BE(0xffffffff, 92); // next_track_id
  return fullBox('mvhd', 0, 0, payload);
}

function makeTkhd(trackId: number): Buffer {
  const payload = Buffer.alloc(80);
  payload.writeUInt32BE(trackId, 8); // track_ID
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

function makeSmhd(): Buffer {
  return fullBox('smhd', 0, 0, Buffer.alloc(4));
}

function makeDinf(): Buffer {
  const url = fullBox('url ', 0, 0x000001, Buffer.alloc(0));
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1, 0);
  const dref = fullBox('dref', 0, 0, Buffer.concat([count, url]));
  return box('dinf', dref);
}

function makeStsd(sampleEntryType: string): Buffer {
  const entry = box(sampleEntryType, Buffer.alloc(78));
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1, 0);
  return fullBox('stsd', 0, 0, Buffer.concat([count, entry]));
}

/** Build one trak (video or audio) for the original fragmented moov. */
function makeTrak(opts: {
  trackId: number;
  timescale: number;
  handler: 'vide' | 'soun';
}): Buffer {
  const { trackId, timescale, handler } = opts;
  const tkhd = makeTkhd(trackId);
  const mdhd = makeMdhd(timescale);
  const hdlr = makeHdlr(handler);
  const mhd = handler === 'vide' ? makeVmhd() : makeSmhd();
  const dinf = makeDinf();
  const stsd = makeStsd(handler === 'vide' ? 'avc1' : 'mp4a');
  const stbl = box('stbl', stsd);
  const minf = box('minf', Buffer.concat([mhd, dinf, stbl]));
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  return box('trak', Buffer.concat([tkhd, mdia]));
}

/** Build a complete fragmented moov (1+ tracks, mvex). */
function makeMoov(opts: {
  mvhdTimescale: number;
  tracks: { trackId: number; timescale: number; handler: 'vide' | 'soun' }[];
}): Buffer {
  const mvhd = makeMvhd(opts.mvhdTimescale);
  const traks = opts.tracks.map(makeTrak);
  const trexBoxes = opts.tracks.map((t) => {
    const trexPayload = Buffer.alloc(20);
    trexPayload.writeUInt32BE(t.trackId, 0);
    trexPayload.writeUInt32BE(1, 4);
    return fullBox('trex', 0, 0, trexPayload);
  });
  const mvex = box('mvex', Buffer.concat(trexBoxes));
  return box('moov', Buffer.concat([mvhd, ...traks, mvex]));
}

function makeClassicMoov1Track(trackId: number, timescale: number): Buffer {
  const mvhd = makeMvhd(timescale);
  const trak = makeTrak({ trackId, timescale, handler: 'vide' });
  return box('moov', Buffer.concat([mvhd, trak]));
}

// ---------------------------------------------------------------------------
// makeExplicitMoofMdat — a moof+mdat (single track) with EXPLICIT per-sample
// sizes in trun so per-sample absolute offsets in the original file are
// deterministic. The mdat payload is FILLED with a recognizable byte pattern
// so the reconstruct test can verify each sample's first byte.
// ---------------------------------------------------------------------------

function makeExplicitMoofMdat(opts: {
  trackId: number;
  moofAbsOffset: number;
  decodeTime: number;
  sampleDurations: number[];
  sampleSizes: number[];
  sampleFlags?: number[];
  /** byte value the first byte of EACH sample is set to; index passed in */
  fillByte: (globalSampleIndex: number) => number;
  /** running global sample index start (for fillByte uniqueness across frags) */
  startGlobalIndex: number;
}): { bytes: Buffer; mdatPayloadStart: number } {
  const {
    trackId,
    moofAbsOffset,
    decodeTime,
    sampleDurations,
    sampleSizes,
    sampleFlags,
    fillByte,
    startGlobalIndex,
  } = opts;
  const N = sampleDurations.length;
  if (sampleSizes.length !== N) throw new Error('durations/sizes length mismatch');
  const hasFlags = sampleFlags !== undefined;
  const perSample = hasFlags ? 12 : 8;

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

  const trunFlags = hasFlags ? 0x000701 : 0x000301;
  const trunPayload = Buffer.alloc(4 + 4 + N * perSample);
  trunPayload.writeUInt32BE(N, 0);
  trunPayload.writeInt32BE(0, 4);
  let tp = 8;
  for (let i = 0; i < N; i++) {
    trunPayload.writeUInt32BE(sampleDurations[i], tp);
    trunPayload.writeUInt32BE(sampleSizes[i], tp + 4);
    tp += 8;
    if (hasFlags) {
      trunPayload.writeUInt32BE(sampleFlags![i], tp);
      tp += 4;
    }
  }
  const trun = fullBox('trun', 0, trunFlags, trunPayload);

  const traf = box('traf', Buffer.concat([tfhd, tfdt, trun]));
  const moof = box('moof', Buffer.concat([mfhd, traf]));
  if (moof.length !== moofSize) {
    throw new Error(`moof size mismatch: expected ${moofSize}, got ${moof.length}`);
  }

  const mdatPayloadSize = sampleSizes.reduce((a, b) => a + b, 0);
  const mdatPayload = Buffer.alloc(mdatPayloadSize);
  // Write a recognizable pattern: the first byte of each sample = fillByte(idx),
  // the rest filled with idx+0x80 so we can detect mid-sample bytes too.
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const gi = startGlobalIndex + i;
    mdatPayload.fill((gi + 0x80) & 0xff, cursor, cursor + sampleSizes[i]);
    mdatPayload.writeUInt8(fillByte(gi) & 0xff, cursor);
    cursor += sampleSizes[i];
  }
  const mdat = box('mdat', mdatPayload);
  return { bytes: Buffer.concat([moof, mdat]), mdatPayloadStart };
}

/** RangeFetcher backed by an in-memory buffer. */
function bufFetcher(file: Buffer): RangeFetcher {
  return async (start: number, end: number) => Buffer.from(file.subarray(start, end + 1));
}

// ---------------------------------------------------------------------------
// Reconstruct the served stream from a packed clean_frame sidecar.
// served = prelude ++ mdatHeader ++ (copy each byteRange from the original).
// ---------------------------------------------------------------------------

function reconstruct(sidecar: ReturnType<typeof unpackCleanFrameSidecar>, original: Buffer): Buffer {
  const parts: Buffer[] = [sidecar.prelude, sidecar.mdatHeader];
  for (const r of sidecar.byteRanges) {
    parts.push(Buffer.from(original.subarray(r.srcOffset, r.srcOffset + r.length)));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Parse a moov's per-track sample tables back out of the reconstructed stream
// so we can assert byte-exactness. Returns, per track, the list of resolved
// absolute byte offsets of each sample in the served stream (computed from
// stco/co64 + stsc + stsz), in stbl sample order.
// ---------------------------------------------------------------------------

interface ParsedSampleTable {
  /** served-stream absolute offset of each sample's first byte, in stbl order */
  sampleOffsets: number[];
  sampleSizes: number[];
}

function parseSampleTables(servedMoovBuf: Buffer, moovOffset: number): ParsedSampleTable[] {
  const moovHdr = readBoxHeader(servedMoovBuf, moovOffset)!;
  const dataStart = moovOffset + moovHdr.headerSize;
  const dataEnd = moovOffset + moovHdr.size;
  const out: ParsedSampleTable[] = [];

  let p = dataStart;
  while (p + 8 <= dataEnd) {
    const h = readBoxHeader(servedMoovBuf, p);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') {
      const stbl = findStbl(servedMoovBuf, p, h);
      if (stbl) out.push(parseStbl(servedMoovBuf, stbl.offset, stbl.header));
    }
    p += h.size;
  }
  return out;
}

function findStbl(
  buf: Buffer,
  trakOff: number,
  trakHdr: { headerSize: number; size: number },
): { offset: number; header: { headerSize: number; size: number } } | null {
  const mdia = findChildBox(buf, trakOff + trakHdr.headerSize, trakOff + trakHdr.size, 'mdia');
  if (!mdia) return null;
  const minf = findChildBox(
    buf,
    mdia.offset + mdia.header.headerSize,
    mdia.offset + mdia.header.size,
    'minf',
  );
  if (!minf) return null;
  const stbl = findChildBox(
    buf,
    minf.offset + minf.header.headerSize,
    minf.offset + minf.header.size,
    'stbl',
  );
  return stbl;
}

function parseStbl(
  buf: Buffer,
  stblOff: number,
  stblHdr: { headerSize: number; size: number },
): ParsedSampleTable {
  const start = stblOff + stblHdr.headerSize;
  const end = stblOff + stblHdr.size;

  // stsz: sample sizes
  const stsz = findChildBox(buf, start, end, 'stsz')!;
  const stszBase = stsz.offset + stsz.header.headerSize + 4; // skip ver+flags
  const sampleSize = buf.readUInt32BE(stszBase);
  const sampleCount = buf.readUInt32BE(stszBase + 4);
  const sampleSizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sampleSizes.push(sampleSize !== 0 ? sampleSize : buf.readUInt32BE(stszBase + 8 + i * 4));
  }

  // stsc: samples-per-chunk runs → expand to per-chunk samplesPerChunk
  const stsc = findChildBox(buf, start, end, 'stsc')!;
  const stscBase = stsc.offset + stsc.header.headerSize + 4;
  const stscCount = buf.readUInt32BE(stscBase);
  const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
  for (let i = 0; i < stscCount; i++) {
    const eo = stscBase + 4 + i * 12;
    stscEntries.push({
      firstChunk: buf.readUInt32BE(eo),
      samplesPerChunk: buf.readUInt32BE(eo + 4),
    });
  }

  // stco / co64: per-chunk offsets
  const stco = findChildBox(buf, start, end, 'stco') ?? findChildBox(buf, start, end, 'co64');
  if (!stco) throw new Error('no stco/co64');
  const isCo64 = stco.header.type === 'co64';
  const stcoBase = stco.offset + stco.header.headerSize + 4;
  const chunkCount = buf.readUInt32BE(stcoBase);
  const chunkOffsets: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (isCo64) {
      const eo = stcoBase + 4 + i * 8;
      chunkOffsets.push(buf.readUInt32BE(eo) * 0x100000000 + buf.readUInt32BE(eo + 4));
    } else {
      chunkOffsets.push(buf.readUInt32BE(stcoBase + 4 + i * 4));
    }
  }

  // Resolve samples_per_chunk for every chunk from stsc runs.
  function samplesPerChunk(chunkIndex1Based: number): number {
    let spc = stscEntries[0].samplesPerChunk;
    for (const e of stscEntries) {
      if (e.firstChunk <= chunkIndex1Based) spc = e.samplesPerChunk;
      else break;
    }
    return spc;
  }

  // Walk chunks → samples, computing each sample's served absolute offset =
  // chunkOffset + Σ(sizes of preceding samples in the same chunk).
  const sampleOffsets: number[] = [];
  let sampleIdx = 0;
  for (let c = 0; c < chunkCount; c++) {
    const spc = samplesPerChunk(c + 1);
    let off = chunkOffsets[c];
    for (let s = 0; s < spc; s++) {
      if (sampleIdx >= sampleCount) break;
      sampleOffsets.push(off);
      off += sampleSizes[sampleIdx];
      sampleIdx++;
    }
  }

  return { sampleOffsets, sampleSizes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCleanFrameSidecar', () => {
  it('truncated upload: drops samples whose data falls past fileSize — no byteRange overshoots EOF', async () => {
    // A truncated FTPS upload: the moov/moof headers (at the front) describe the
    // FULL recording, but the file is cut short, so the last sample's mdat bytes
    // are missing. The builder must NOT emit a byteRange that reads past EOF
    // (that's the prod bug: maxSrcEnd > fileSize → tail 502/loading error).
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;
    const frag1 = makeExplicitMoofMdat({
      trackId, moofAbsOffset: mediaStart, decodeTime: 0,
      sampleDurations: [3000, 3000, 3000], sampleSizes: [100, 200, 300],
      fillByte: (gi) => 0x10 + gi, startGlobalIndex: 0,
    });
    const frag2 = makeExplicitMoofMdat({
      trackId, moofAbsOffset: mediaStart + frag1.bytes.length, decodeTime: 9000,
      sampleDurations: [3000, 3000, 3000], sampleSizes: [150, 250, 350],
      fillByte: (gi) => 0x10 + gi, startGlobalIndex: 3,
    });
    const fullFile = Buffer.concat([ftyp, moov, frag1.bytes, frag2.bytes]);
    // Cut the last 200 bytes — the final sample (350 B) is now incomplete.
    const truncatedSize = fullFile.length - 200;
    const truncFile = fullFile.subarray(0, truncatedSize);

    const packed = (await buildCleanFrameSidecar(truncFile, truncatedSize, bufFetcher(truncFile)))?.buf ?? null;
    expect(packed).not.toBeNull();
    const sidecar = unpackCleanFrameSidecar(packed!);

    const maxEnd = Math.max(...sidecar.byteRanges.map((r) => r.srcOffset + r.length));
    expect(maxEnd).toBeLessThanOrEqual(truncatedSize);
    // Only the last (incomplete) sample is dropped → kept bytes = 100+200+300+150+250.
    const totalBytes = sidecar.byteRanges.reduce((a, r) => a + r.length, 0);
    expect(totalBytes).toBe(1000);
    // The served stream reconstructs without reading past the truncated EOF.
    const served = reconstruct(sidecar, truncFile);
    expect(served.length).toBeGreaterThan(0);
  });

  it('reports truncation to the caller instead of only logging it', async (ctx) => {
    story(
      ctx,
      'Builder od zawsze WIEDZIAŁ, że plik jest ucięty — `trimTracksToFileSize` zwraca `trimmed` — ale sygnał kończył się na console.warn i tam ginął. Dlatego pół nagrania było nie do odróżnienia od kompletnego. Werdykt jest teraz częścią typu zwracanego, więc nie da się go po cichu zgubić. Jest STRUKTURALNY: czyta tablice próbek samego pliku, więc działa niezależnie od tego, JAK skończył się upload — inaczej niż heurystyka po stronie FTPS, która łapie wyłącznie zerwanie kanału kontrolnego.',
    );

    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;
    const frag = makeExplicitMoofMdat({
      trackId, moofAbsOffset: mediaStart, decodeTime: 0,
      sampleDurations: [3000, 3000], sampleSizes: [100, 200],
      fillByte: (gi) => 0x40 + gi, startGlobalIndex: 0,
    });
    const file = Buffer.concat([ftyp, moov, frag.bytes]);

    const whole = await buildCleanFrameSidecar(file, file.length, bufFetcher(file));
    expect(whole).not.toBeNull();
    expect(whole!.truncated).toBe(false);

    // Cut into the final sample so its data no longer fits inside the file.
    const cutSize = file.length - 120;
    const cut = file.subarray(0, cutSize);
    const short = await buildCleanFrameSidecar(cut, cutSize, bufFetcher(cut));
    expect(short).not.toBeNull();
    expect(short!.truncated).toBe(true);
  });

  it('Test 1: reconstruct + offset-exactness — every sample table entry points at the right byte', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;

    // distinct first byte per sample so we can verify exact placement
    const firstBytes: number[] = [];
    const frag1 = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart,
      decodeTime: 0,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [100, 200, 300],
      fillByte: (gi) => {
        const b = 0x10 + gi;
        firstBytes[gi] = b & 0xff;
        return b;
      },
      startGlobalIndex: 0,
    });
    const frag2 = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart + frag1.bytes.length,
      decodeTime: 9000,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [150, 250, 350],
      fillByte: (gi) => {
        const b = 0x10 + gi;
        firstBytes[gi] = b & 0xff;
        return b;
      },
      startGlobalIndex: 3,
    });

    const file = Buffer.concat([ftyp, moov, frag1.bytes, frag2.bytes]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).not.toBeNull();
    const sidecar = unpackCleanFrameSidecar(packed!);

    // Reconstruct the served stream.
    const served = reconstruct(sidecar, file);

    // The served stream must be [ftyp][moov][mdat header][compacted bytes].
    const ftypHdr = readBoxHeader(served, 0)!;
    expect(ftypHdr.type).toBe('ftyp');
    const moovOff = ftypHdr.size;
    const servedMoovHdr = readBoxHeader(served, moovOff)!;
    expect(servedMoovHdr.type).toBe('moov');
    // faststart: moov BEFORE mdat
    const mdatOff = moovOff + servedMoovHdr.size;
    const mdatHdr = readBoxHeader(served, mdatOff)!;
    expect(mdatHdr.type).toBe('mdat');

    // Parse the served sample tables and verify EVERY sample points at the
    // exact byte the original had at its absOffset.
    const tables = parseSampleTables(served, moovOff);
    expect(tables.length).toBe(1);

    // Original samples in served order = file order. 6 samples, sizes
    // [100,200,300,150,250,350], first bytes firstBytes[0..5].
    const expectedSizes = [100, 200, 300, 150, 250, 350];
    expect(tables[0].sampleSizes).toEqual(expectedSizes);
    for (let i = 0; i < 6; i++) {
      const off = tables[0].sampleOffsets[i];
      // byte at the computed served offset must equal the original first byte
      expect(served.readUInt8(off)).toBe(firstBytes[i]);
      // and the whole sample's tail byte too (pattern = (gi+0x80)&0xff)
      const tail = served.readUInt8(off + expectedSizes[i] - 1);
      expect(tail).toBe((i + 0x80) & 0xff);
    }

    // The mdat payload size must equal the sum of all sample sizes.
    const totalBytes = expectedSizes.reduce((a, b) => a + b, 0);
    expect(mdatHdr.size - mdatHdr.headerSize).toBe(totalBytes);
  });

  it('Test 8: empty trun (sampleCount 0) is dropped, not treated as a chunk', async () => {
    // Some real clips carry a fragment with an empty trun (a track with no
    // samples in that fragment). Such a run has a firstSampleAbsOffset but emits
    // no sample at it, so before the empty-run filter the compacted-map lookup
    // threw `run firstSampleAbsOffset … not in served map` → null sidecar (the
    // ~2% prod backfill failures). The empty run contributes 0 samples + 0 bytes
    // and must simply be dropped; the surrounding real samples stay offset-exact.
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;

    const firstBytes: number[] = [];
    const fill = (gi: number) => { const b = 0x10 + gi; firstBytes[gi] = b & 0xff; return b; };

    const frag1 = makeExplicitMoofMdat({
      trackId, moofAbsOffset: mediaStart, decodeTime: 0,
      sampleDurations: [3000, 3000], sampleSizes: [100, 200], fillByte: fill, startGlobalIndex: 0,
    });
    // EMPTY fragment: trun with zero samples (and an empty mdat).
    const empty = makeExplicitMoofMdat({
      trackId, moofAbsOffset: mediaStart + frag1.bytes.length, decodeTime: 6000,
      sampleDurations: [], sampleSizes: [], fillByte: () => 0, startGlobalIndex: 2,
    });
    const frag2 = makeExplicitMoofMdat({
      trackId, moofAbsOffset: mediaStart + frag1.bytes.length + empty.bytes.length, decodeTime: 6000,
      sampleDurations: [3000, 3000], sampleSizes: [150, 250], fillByte: fill, startGlobalIndex: 2,
    });

    const file = Buffer.concat([ftyp, moov, frag1.bytes, empty.bytes, frag2.bytes]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).not.toBeNull(); // pre-fix this was null (empty run threw)

    const sidecar = unpackCleanFrameSidecar(packed!);
    const served = reconstruct(sidecar, file);
    const ftypHdr = readBoxHeader(served, 0)!;
    const tables = parseSampleTables(served, ftypHdr.size);
    expect(tables.length).toBe(1);
    // 4 real samples (the empty fragment contributes none), offset-exact.
    expect(tables[0].sampleSizes).toEqual([100, 200, 150, 250]);
    for (let i = 0; i < 4; i++) {
      expect(served.readUInt8(tables[0].sampleOffsets[i])).toBe(firstBytes[i]);
    }
  });

  it('Test 2: moov appears BEFORE mdat (faststart) in the prelude', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;
    const frag = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart,
      decodeTime: 0,
      sampleDurations: [3000, 3000],
      sampleSizes: [100, 200],
      fillByte: (gi) => 0x10 + gi,
      startGlobalIndex: 0,
    });
    const file = Buffer.concat([ftyp, moov, frag.bytes]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).not.toBeNull();
    const sidecar = unpackCleanFrameSidecar(packed!);

    // prelude = [ftyp][moov]; the mdat is NOT in the prelude (it's mdatHeader +
    // streamed byteRanges).
    const ftypHdr = readBoxHeader(sidecar.prelude, 0)!;
    expect(ftypHdr.type).toBe('ftyp');
    const moovHdr = readBoxHeader(sidecar.prelude, ftypHdr.size)!;
    expect(moovHdr.type).toBe('moov');
    // prelude ends exactly at the end of moov (nothing after)
    expect(ftypHdr.size + moovHdr.size).toBe(sidecar.prelude.length);
    // mdatHeader declares an mdat box
    const mdatHdr = readBoxHeader(sidecar.mdatHeader, 0)!;
    expect(mdatHdr.type).toBe('mdat');
  });

  it('Test 3: Σ byteRanges.length === Σ sample sizes, and ranges exclude moof bytes', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;
    const frag1 = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart,
      decodeTime: 0,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [100, 200, 300],
      fillByte: (gi) => 0x10 + gi,
      startGlobalIndex: 0,
    });
    const frag2 = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart + frag1.bytes.length,
      decodeTime: 9000,
      sampleDurations: [3000, 3000, 3000],
      sampleSizes: [150, 250, 350],
      fillByte: (gi) => 0x10 + gi,
      startGlobalIndex: 3,
    });
    const file = Buffer.concat([ftyp, moov, frag1.bytes, frag2.bytes]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).not.toBeNull();
    const sidecar = unpackCleanFrameSidecar(packed!);

    const totalSampleBytes = [100, 200, 300, 150, 250, 350].reduce((a, b) => a + b, 0);
    const totalRangeBytes = sidecar.byteRanges.reduce((a, r) => a + r.length, 0);
    expect(totalRangeBytes).toBe(totalSampleBytes);

    // The two fragments' mdat payloads are NOT contiguous in the original file
    // (a whole moof header sits between frag1's last sample and frag2's first),
    // so byteRanges should have exactly 2 runs.
    expect(sidecar.byteRanges.length).toBe(2);
    // First range starts at frag1 mdat payload start, length = 600.
    expect(sidecar.byteRanges[0].srcOffset).toBe(frag1.mdatPayloadStart);
    expect(sidecar.byteRanges[0].length).toBe(600);
    expect(sidecar.byteRanges[1].srcOffset).toBe(frag2.mdatPayloadStart);
    expect(sidecar.byteRanges[1].length).toBe(750);
    // No range may overlap a moof region (frag boundaries) — verified above by
    // the exact offsets landing on mdat payload starts.
  });

  it('Test 4: frameGrid.length === video sample count and is sorted ascending', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov({ mvhdTimescale: timescale, tracks: [{ trackId, timescale, handler: 'vide' }] });
    const mediaStart = ftyp.length + moov.length;
    const frag = makeExplicitMoofMdat({
      trackId,
      moofAbsOffset: mediaStart,
      decodeTime: 0,
      sampleDurations: [3000, 3000, 3000, 3000],
      sampleSizes: [100, 200, 300, 400],
      fillByte: (gi) => 0x10 + gi,
      startGlobalIndex: 0,
    });
    const file = Buffer.concat([ftyp, moov, frag.bytes]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).not.toBeNull();
    const sidecar = unpackCleanFrameSidecar(packed!);

    expect(sidecar.frameGrid.length).toBe(4);
    for (let i = 1; i < sidecar.frameGrid.length; i++) {
      expect(sidecar.frameGrid[i]).toBeGreaterThanOrEqual(sidecar.frameGrid[i - 1]);
    }
  });

  it('Test 5: non-fragmented (no moof) input → null', async () => {
    const ftyp = makeFtyp();
    const moov = makeClassicMoov1Track(1, 90000);
    const mdat = box('mdat', Buffer.alloc(64));
    const file = Buffer.concat([ftyp, moov, mdat]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).toBeNull();
  });

  it('Test 6: no-moov input → null', async () => {
    const ftyp = makeFtyp();
    const mdat = box('mdat', Buffer.alloc(64));
    const file = Buffer.concat([ftyp, mdat]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).toBeNull();
  });

  it('Test 7: multi-track (video + audio) — interleaved samples are compacted in served (file) order, offsets exact', async () => {
    const vTrack = 1;
    const aTrack = 2;
    const vTs = 90000;
    const aTs = 16000;
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: vTs,
      tracks: [
        { trackId: vTrack, timescale: vTs, handler: 'vide' },
        { trackId: aTrack, timescale: aTs, handler: 'soun' },
      ],
    });
    const mediaStart = ftyp.length + moov.length;

    // Interleave: video moof+mdat, then audio moof+mdat.
    const firstBytes = new Map<number, number>(); // absOffset -> byte
    let off = mediaStart;
    const vFrag = makeExplicitMoofMdat({
      trackId: vTrack,
      moofAbsOffset: off,
      decodeTime: 0,
      sampleDurations: [3000, 3000],
      sampleSizes: [100, 200],
      fillByte: (gi) => 0x10 + gi,
      startGlobalIndex: 0,
    });
    off += vFrag.bytes.length;
    const aFrag = makeExplicitMoofMdat({
      trackId: aTrack,
      moofAbsOffset: off,
      decodeTime: 0,
      sampleDurations: [1024, 1024, 1024],
      sampleSizes: [40, 50, 60],
      fillByte: (gi) => 0x50 + gi,
      startGlobalIndex: 0,
    });

    const file = Buffer.concat([ftyp, moov, vFrag.bytes, aFrag.bytes]);
    const packed = (await buildCleanFrameSidecar(file, file.length, bufFetcher(file)))?.buf ?? null;
    expect(packed).not.toBeNull();
    const sidecar = unpackCleanFrameSidecar(packed!);

    // Record original first bytes by absOffset.
    // video samples
    {
      let o = vFrag.mdatPayloadStart;
      const sizes = [100, 200];
      for (let i = 0; i < 2; i++) {
        firstBytes.set(o, file.readUInt8(o));
        o += sizes[i];
      }
    }
    {
      let o = aFrag.mdatPayloadStart;
      const sizes = [40, 50, 60];
      for (let i = 0; i < 3; i++) {
        firstBytes.set(o, file.readUInt8(o));
        o += sizes[i];
      }
    }

    const served = reconstruct(sidecar, file);
    const ftypHdr = readBoxHeader(served, 0)!;
    const moovOff = ftypHdr.size;
    const tables = parseSampleTables(served, moovOff);
    expect(tables.length).toBe(2);

    // Verify each track's samples point at exactly the right bytes.
    // Track order in moov = [video, audio]. For each, the served offset of
    // sample i must hold the same first byte as the original.
    // Reconstruct expected original first bytes per track in stbl order:
    const vSizes = [100, 200];
    let vo = vFrag.mdatPayloadStart;
    for (let i = 0; i < 2; i++) {
      const expByte = file.readUInt8(vo);
      const servedOff = tables[0].sampleOffsets[i];
      expect(served.readUInt8(servedOff)).toBe(expByte);
      vo += vSizes[i];
    }
    const aSizes = [40, 50, 60];
    let ao = aFrag.mdatPayloadStart;
    for (let i = 0; i < 3; i++) {
      const expByte = file.readUInt8(ao);
      const servedOff = tables[1].sampleOffsets[i];
      expect(served.readUInt8(servedOff)).toBe(expByte);
      ao += aSizes[i];
    }

    // Σ byteRanges === Σ sample sizes (all tracks)
    const totalSampleBytes = [100, 200, 40, 50, 60].reduce((a, b) => a + b, 0);
    const totalRangeBytes = sidecar.byteRanges.reduce((a, r) => a + r.length, 0);
    expect(totalRangeBytes).toBe(totalSampleBytes);

    // frameGrid is the VIDEO track only → 2 entries.
    expect(sidecar.frameGrid.length).toBe(2);
  });
});
