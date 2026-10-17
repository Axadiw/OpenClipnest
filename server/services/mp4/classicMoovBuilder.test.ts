import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { readBoxHeader } from './boxes.js';
import { parseAllSamples, parseTrexDefaultFlags } from './classicMoovBuilder.js';
import type { RangeFetcher } from './fragmentIndex.js';

// ---------------------------------------------------------------------------
// Local box-building helpers (mirrors __test-fixtures.ts primitives but kept
// local so this test owns the structurally-complete moov it needs — the
// builder reads stsd/hdlr/vmhd/dinf out of the original moov, which the shared
// `makeMoov` fixture doesn't synthesize).
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
  // pre_defined(4) handler_type(4) reserved(12) name(\0)
  const payload = Buffer.alloc(4 + 4 + 12 + 1);
  payload.write(handlerType, 4, 'ascii');
  return fullBox('hdlr', 0, 0, payload);
}

function makeVmhd(): Buffer {
  // graphicsmode(2) opcolor(6)
  return fullBox('vmhd', 0, 0x000001, Buffer.alloc(8));
}

function makeDinf(): Buffer {
  // dref: entry_count(4) + one 'url ' entry with self-contained flag
  const url = fullBox('url ', 0, 0x000001, Buffer.alloc(0));
  const drefPayload = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(1, 0);
      return b;
    })(),
    url,
  ]);
  const dref = fullBox('dref', 0, 0, drefPayload);
  return box('dinf', dref);
}

function makeStsd(): Buffer {
  // entry_count(4) + one minimal 'avc1' sample entry (just a box header is
  // enough structurally for our copy-verbatim path).
  const avc1 = box('avc1', Buffer.alloc(78)); // 78 = standard visual sample-entry head
  const payload = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(1, 0);
      return b;
    })(),
    avc1,
  ]);
  return fullBox('stsd', 0, 0, payload);
}

/** Build a complete single-track moov (video) the builder can read from. */
function makeMoov1Track(trackId: number, timescale: number): Buffer {
  const mvhd = makeMvhd(timescale);

  const tkhd = makeTkhd(trackId);
  const mdhd = makeMdhd(timescale);
  const hdlr = makeHdlr('vide');
  const vmhd = makeVmhd();
  const dinf = makeDinf();
  const stsd = makeStsd();
  // original stbl in the fragmented moov is empty (no stco/stsz) — builder
  // only copies stsd out of it.
  const stbl = box('stbl', stsd);
  const minf = box('minf', Buffer.concat([vmhd, dinf, stbl]));
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  const trak = box('trak', Buffer.concat([tkhd, mdia]));

  // mvex + trex (fragmented)
  const trexPayload = Buffer.alloc(20);
  trexPayload.writeUInt32BE(trackId, 0);
  trexPayload.writeUInt32BE(1, 4); // sample_description_index
  const trex = fullBox('trex', 0, 0, trexPayload);
  const mvex = box('mvex', trex);

  return box('moov', Buffer.concat([mvhd, trak, mvex]));
}

/** A classic (no-mvex) moov for the null-path test. */
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

// ---------------------------------------------------------------------------
// makeExplicitMoofMdat — a moof+mdat with EXPLICIT per-sample sizes in trun so
// per-sample absolute offsets are deterministic. base_data_offset points at
// the first byte of the mdat payload.
// ---------------------------------------------------------------------------

function makeExplicitMoofMdat(opts: {
  trackId: number;
  moofAbsOffset: number;
  decodeTime: number;
  sampleDurations: number[];
  sampleSizes: number[];
  /** optional per-sample sample_flags (bit 0x10000 = non_sync_sample) */
  sampleFlags?: number[];
}): Buffer {
  const { trackId, moofAbsOffset, decodeTime, sampleDurations, sampleSizes, sampleFlags } =
    opts;
  const N = sampleDurations.length;
  if (sampleSizes.length !== N) throw new Error('durations/sizes length mismatch');
  if (sampleFlags && sampleFlags.length !== N)
    throw new Error('durations/flags length mismatch');

  const hasFlags = sampleFlags !== undefined;
  // per-sample record = duration(4) + size(4) [+ flags(4) when present]
  const perSample = hasFlags ? 12 : 8;

  // Pre-compute moof size to fill base_data_offset.
  // moof = 92 + N*perSample; mdat payload starts at moofAbsOffset + moofSize + 8.
  const moofSize = 92 + N * perSample;
  const mdatPayloadStart = moofAbsOffset + moofSize + 8;

  // mfhd: seq_num=1
  const mfhd = fullBox('mfhd', 0, 0, Buffer.from([0, 0, 0, 1]));

  // tfhd: flags=0x1 (base_data_offset_present), track_id, base_data_offset(u64)
  const tfhdPayload = Buffer.alloc(4 + 8);
  tfhdPayload.writeUInt32BE(trackId, 0);
  // base_data_offset as u64
  tfhdPayload.writeUInt32BE(Math.floor(mdatPayloadStart / 0x100000000), 4);
  tfhdPayload.writeUInt32BE(mdatPayloadStart >>> 0, 8);
  const tfhd = fullBox('tfhd', 0, 0x000001, tfhdPayload);

  // tfdt v0: decodeTime
  const tfdtPayload = Buffer.alloc(4);
  tfdtPayload.writeUInt32BE(decodeTime, 0);
  const tfdt = fullBox('tfdt', 0, 0, tfdtPayload);

  // trun: flags=0x301 (data_offset | sample_duration | sample_size) or 0x701
  // (also sample_flags). data_offset=0, per-sample {duration, size[, flags]}.
  const trunFlags = hasFlags ? 0x000701 : 0x000301;
  const trunPayload = Buffer.alloc(4 + 4 + N * perSample);
  trunPayload.writeUInt32BE(N, 0); // sample_count
  trunPayload.writeInt32BE(0, 4); // data_offset
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
  const mdat = box('mdat', Buffer.alloc(mdatPayloadSize));
  return Buffer.concat([moof, mdat]);
}

/** RangeFetcher backed by an in-memory buffer. */
function bufFetcher(file: Buffer): RangeFetcher {
  return async (start: number, end: number) =>
    Buffer.from(file.subarray(start, end + 1));
}


// ---------------------------------------------------------------------------
// parseAllSamples — focused unit tests
// ---------------------------------------------------------------------------

describe('parseAllSamples', () => {
  it('returns non-null with 1 track and correct sample/moof counts for a 2-fragment file', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov1Track(trackId, timescale);
    const mediaStart = ftyp.length + moov.length;

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
    const result = await parseAllSamples(file, file.length, bufFetcher(file));

    expect(result).not.toBeNull();
    expect(result!.tracks.length).toBe(1);
    // 6 total samples across 2 fragments
    expect(result!.tracks[0].samples.length).toBeGreaterThan(0);
    expect(result!.tracks[0].samples.length).toBe(6);
    // 2 moofs
    expect(result!.moofOffsets.length).toBe(2);
    expect(result!.moofOffsets).toEqual([mediaStart, mediaStart + frag1.length]);
    // mediaStart / mediaEnd
    expect(result!.mediaStart).toBe(mediaStart);
    expect(result!.mediaEnd).toBe(file.length);
  });

  it('returns null for a non-fragmented (class B/C) file with no moof boxes', async () => {
    const ftyp = makeFtyp();
    const moov = makeClassicMoov1Track(1, 90000);
    const mdat = box('mdat', Buffer.alloc(64));
    const file = Buffer.concat([ftyp, moov, mdat]);

    const result = await parseAllSamples(file, file.length, bufFetcher(file));
    expect(result).toBeNull();
  });

  it('returns correct runs count matching fragment count', async () => {
    const trackId = 1;
    const timescale = 90000;
    const ftyp = makeFtyp();
    const moov = makeMoov1Track(trackId, timescale);
    const mediaStart = ftyp.length + moov.length;

    // Three fragments: 2, 5, 4 samples = 11 total
    const counts = [2, 5, 4];
    let off = mediaStart;
    const frags: Buffer[] = [];
    let dt = 0;
    for (const c of counts) {
      const durs = Array(c).fill(2000);
      const sizes = Array.from({ length: c }, (_, i) => 100 + i * 10);
      const frag = makeExplicitMoofMdat({
        trackId,
        moofAbsOffset: off,
        decodeTime: dt,
        sampleDurations: durs,
        sampleSizes: sizes,
      });
      frags.push(frag);
      off += frag.length;
      dt += c * 2000;
    }

    const file = Buffer.concat([ftyp, moov, ...frags]);
    const result = await parseAllSamples(file, file.length, bufFetcher(file));

    expect(result).not.toBeNull();
    expect(result!.tracks.length).toBe(1);
    expect(result!.tracks[0].samples.length).toBe(11);
    // one run per fragment = 3 runs
    expect(result!.tracks[0].runs.length).toBe(3);
    expect(result!.moofOffsets.length).toBe(3);
  });

  it('returns null when the file starts with non-ftyp box', async () => {
    // A buffer starting with mdat instead of ftyp
    const mdat = box('mdat', Buffer.alloc(32));
    const result = await parseAllSamples(mdat, mdat.length, bufFetcher(mdat));
    expect(result).toBeNull();
  });
});

describe('parseTrexDefaultFlags (sync-flag fallback source)', () => {
  // Regression for the .clean_frame all-keyframe stss bug: clips whose sync
  // state is defined ONLY by the trex default_sample_flags (tfhd omits its own)
  // were parsed with flags=0 (= sync) for every sample, so AVAssetImageGenerator
  // failed -11821 on any seek. The parser must surface the trex defaults.
  function trex(trackId: number, defaultSampleFlags: number): Buffer {
    const p = Buffer.alloc(20);
    p.writeUInt32BE(trackId, 0);        // track_ID
    p.writeUInt32BE(1, 4);              // default_sample_description_index
    p.writeUInt32BE(3000, 8);          // default_sample_duration
    p.writeUInt32BE(0, 12);            // default_sample_size
    p.writeUInt32BE(defaultSampleFlags, 16); // default_sample_flags
    return fullBox('trex', 0, 0, p);
  }

  it('reads default_sample_flags per track from moov/mvex/trex', () => {
    // 0x10000 = sample_is_non_sync_sample (the typical "this track's samples are
    // not keyframes unless a trun/first-sample-flag says otherwise" default).
    const moov = box('moov', box('mvex', Buffer.concat([trex(1, 0x10000), trex(2, 0)])));
    const hdr = readBoxHeader(moov, 0)!;
    const flags = parseTrexDefaultFlags(moov, 0, hdr);
    expect(flags.get(1)).toBe(0x10000);
    expect(flags.get(2)).toBe(0);
    expect(flags.has(3)).toBe(false);
  });

  it('returns an empty map when there is no mvex/trex', () => {
    const moov = box('moov', Buffer.alloc(0));
    const hdr = readBoxHeader(moov, 0)!;
    expect(parseTrexDefaultFlags(moov, 0, hdr).size).toBe(0);
  });
});
