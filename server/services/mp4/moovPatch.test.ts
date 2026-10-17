import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { buildPatchedMoov, patchPreludeMvhdDuration } from './moovPatch.js';
import { inspectMoov } from './moov.js';
import { readBoxHeader } from './boxes.js';
import { makeMoov, makeTrakWithElst, makeFtyp, makeMvhd, makeTrex, box } from './__test-fixtures.js';
import { story } from '../../testing/story.js';

describe('buildPatchedMoov', () => {
  it('leaves mvhd/tkhd/mdhd durations at 0 even with non-zero totalDurationSeconds; size unchanged', (ctx) => {
    story(ctx, 'v4 schema: per ISO/IEC 14496-12 §8.30.2.1, gdy mvex obecny i mehd brak, mvhd.duration powinno być 0. Patcher musi to respektować — iOS WebKit dla fragmented MP4 dodaje declared duration do fragment-derived duration, więc każda non-zero wartość prowadzi do 2× over-report. Rozmiar moov musi zostać niezmieniony, żeby tfhd.base_data_offset pozostały valid.');
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const file = Buffer.concat([ftyp, moov]);
    const { moov: info } = inspectMoov(file);
    const origMoovBytes = file.slice(info.moovFileOffset, info.moovFileOffset + info.moovSize);

    // Even with 5s declared, durations must remain 0 (Reolink default).
    const patched = buildPatchedMoov(origMoovBytes, info, 5);
    expect(patched.length).toBe(origMoovBytes.length);
    expect(patched.readUInt32BE(0)).toBe(info.moovSize);

    // Re-inspect: structure unchanged, mehd still absent.
    const patchedFile = Buffer.concat([ftyp, patched]);
    const reinspect = inspectMoov(patchedFile);
    expect(reinspect.moov.moovSize).toBe(info.moovSize);
    expect(reinspect.moov.mvexSize).toBe(info.mvexSize);
    expect(reinspect.moov.hasMehd).toBe(false);

    // Verify mvhd.duration is STILL 0 (patch is intentionally a no-op).
    const mvhdHdr = readBoxHeader(patchedFile, info.moovFileOffset + 8);
    expect(mvhdHdr?.type).toBe('mvhd');
    const mvhdDuration = patchedFile.readUInt32BE(info.moovFileOffset + 8 + 8 + 16);
    expect(mvhdDuration).toBe(0);

    // tkhd.duration also stays 0. Walk: moov.header(8) + mvhd.size, then trak.
    const moovHdr = readBoxHeader(patched, 0)!;
    const mvhdInMoovHdr = readBoxHeader(patched, moovHdr.headerSize)!;
    const trakOff = moovHdr.headerSize + mvhdInMoovHdr.size;
    const trakHdr = readBoxHeader(patched, trakOff)!;
    expect(trakHdr.type).toBe('trak');
    const tkhdOff = trakOff + trakHdr.headerSize;
    const tkhdHdr = readBoxHeader(patched, tkhdOff)!;
    expect(tkhdHdr.type).toBe('tkhd');
    // tkhd v0 layout: ver+flags(4) creation(4) modification(4) track_id(4) reserved(4) duration(4)
    // duration is at tkhdPayloadStart + 4 + 4 + 4 + 4 + 4 = +20
    expect(patched.readUInt32BE(tkhdOff + 8 + 20)).toBe(0);
  });

  it('neutralises multi-entry elst to empty edit list (entry_count=0)', (ctx) => {
    story(ctx, 'Niektóre firmware Reolink emitują edts/elst z wieloma wpisami. Patcher v4 zeruje entry_count zamiast pisać własny wpis (poprzedni v3 fix pisał entry z segment_duration=tkhd.duration, ale skoro tkhd.duration jest teraz 0, pojedynczy wpis z segment_duration=0 byłby degenerate). Rozmiar moov musi zostać niezmieniony.');
    const ftyp = makeFtyp();
    const trak = makeTrakWithElst(1, 90000, [
      { segmentDuration: 5000, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 },
      { segmentDuration: 5000, mediaTime: 0, mediaRateInteger: 1, mediaRateFraction: 0 },
    ]);
    const mvhd = makeMvhd(1000, 0);
    const mvex = box('mvex', Buffer.concat([makeTrex(1, 3000)]));
    const moov = box('moov', Buffer.concat([mvhd, trak, mvex]));
    const file = Buffer.concat([ftyp, moov]);
    const { moov: info } = inspectMoov(file);
    const origMoovBytes = file.slice(info.moovFileOffset, info.moovFileOffset + info.moovSize);
    const origSize = origMoovBytes.length;

    const patched = buildPatchedMoov(origMoovBytes, info, 5);
    expect(patched.length).toBe(origSize);

    // Find the elst inside the patched moov and verify empty.
    const moovHdr = readBoxHeader(patched, 0)!;
    const mvhdHdr = readBoxHeader(patched, moovHdr.headerSize)!;
    const trakHdr = readBoxHeader(patched, moovHdr.headerSize + mvhdHdr.size)!;
    expect(trakHdr.type).toBe('trak');
    const trakDataStart = moovHdr.headerSize + mvhdHdr.size + trakHdr.headerSize;
    const tkhdHdr = readBoxHeader(patched, trakDataStart)!;
    expect(tkhdHdr.type).toBe('tkhd');
    const edtsOff = trakDataStart + tkhdHdr.size;
    const edtsHdr = readBoxHeader(patched, edtsOff)!;
    expect(edtsHdr.type).toBe('edts');
    const elstOff = edtsOff + edtsHdr.headerSize;
    const elstHdr = readBoxHeader(patched, elstOff)!;
    expect(elstHdr.type).toBe('elst');

    const elstPayload = elstOff + elstHdr.headerSize;
    const entryCount = patched.readUInt32BE(elstPayload + 4);
    expect(entryCount).toBe(0);
  });

  it('neutralises single-entry elst with non-1x rate to empty list', () => {
    const ftyp = makeFtyp();
    const trak = makeTrakWithElst(1, 90000, [
      { segmentDuration: 10000, mediaTime: 5, mediaRateInteger: 2, mediaRateFraction: 0 },
    ]);
    const mvhd = makeMvhd(1000, 0);
    const moov = box('moov', Buffer.concat([mvhd, trak]));
    const file = Buffer.concat([ftyp, moov]);
    const { moov: info } = inspectMoov(file);
    const origMoovBytes = file.slice(info.moovFileOffset, info.moovFileOffset + info.moovSize);

    const patched = buildPatchedMoov(origMoovBytes, info, 5);

    const moovHdr = readBoxHeader(patched, 0)!;
    const mvhdHdr = readBoxHeader(patched, moovHdr.headerSize)!;
    const trakHdr = readBoxHeader(patched, moovHdr.headerSize + mvhdHdr.size)!;
    const trakDataStart = moovHdr.headerSize + mvhdHdr.size + trakHdr.headerSize;
    const tkhdHdr = readBoxHeader(patched, trakDataStart)!;
    const edtsHdr = readBoxHeader(patched, trakDataStart + tkhdHdr.size)!;
    const elstOff = trakDataStart + tkhdHdr.size + edtsHdr.headerSize;
    const elstHdr = readBoxHeader(patched, elstOff)!;
    const elstPayload = elstOff + elstHdr.headerSize;

    expect(patched.readUInt32BE(elstPayload + 4)).toBe(0); // entry_count = 0
  });

  it('is a no-op when track has no edts/elst (most non-Reolink files)', () => {
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
    });
    const file = Buffer.concat([ftyp, moov]);
    const { moov: info } = inspectMoov(file);
    const origMoovBytes = file.slice(info.moovFileOffset, info.moovFileOffset + info.moovSize);
    // Should not throw and should leave structure intact.
    const patched = buildPatchedMoov(origMoovBytes, info, 5);
    expect(patched.length).toBe(origMoovBytes.length);
  });

  it('leaves moov untouched when totalDurationSeconds=0 (degenerate)', () => {
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const ftyp = makeFtyp();
    const { moov: info } = inspectMoov(Buffer.concat([ftyp, moov]));
    const origMoovBytes = moov;
    const patched = buildPatchedMoov(origMoovBytes, info, 0);
    expect(patched.equals(origMoovBytes)).toBe(true);
  });
});

describe('patchPreludeMvhdDuration', () => {
  function makePrelude(mvhdTimescale: number, mvhdDuration: number): Buffer {
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale,
      mvhdDuration,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    return Buffer.concat([ftyp, moov]);
  }

  function readMvhdDuration(prelude: Buffer): number {
    // ftyp is first; moov follows; mvhd is first child of moov.
    const ftyp = readBoxHeader(prelude, 0)!;
    const moovOffset = ftyp.size;
    const moovHdr = readBoxHeader(prelude, moovOffset)!;
    const moovDataStart = moovOffset + moovHdr.headerSize;
    let off = moovDataStart;
    while (off + 8 <= moovOffset + moovHdr.size) {
      const h = readBoxHeader(prelude, off)!;
      if (h.type === 'mvhd') {
        const version = prelude.readUInt8(off + h.headerSize);
        const timescaleOff = off + h.headerSize + 4 + (version === 1 ? 16 : 8);
        const durationOff = timescaleOff + 4;
        return version === 1
          ? prelude.readUInt32BE(durationOff) * 0x100000000 + prelude.readUInt32BE(durationOff + 4)
          : prelude.readUInt32BE(durationOff);
      }
      off += h.size;
    }
    throw new Error('mvhd not found');
  }

  it('writes mvhd.duration ticks from durationMs', (ctx) => {
    story(ctx, 'Chrome\'s probe phase wymaga niezerowego mvhd.duration żeby wiedzieć jak długi jest plik — bez tego skanuje całość i rozbija się w PIPELINE_ERROR_READ. Ta funkcja wpisuje duration in-place tuż przed wysłaniem prelude.');
    const prelude = makePrelude(90000, 0);
    expect(readMvhdDuration(prelude)).toBe(0);
    const copy = Buffer.from(prelude);
    patchPreludeMvhdDuration(copy, 30000); // 30 seconds
    expect(readMvhdDuration(copy)).toBe(30 * 90000); // 2_700_000 ticks
  });

  it('is a no-op when durationMs is 0', (ctx) => {
    story(ctx, 'Zero duration (jeszcze nie wiadomo ile trwa film) nie powinno wpisywać nic — zostawiamy mvhd.duration=0 i Chrome radzi sobie przez mfra tail-fetch.');
    const prelude = makePrelude(90000, 0);
    const copy = Buffer.from(prelude);
    patchPreludeMvhdDuration(copy, 0);
    expect(readMvhdDuration(copy)).toBe(0);
  });

  it('does not mutate the original buffer', (ctx) => {
    story(ctx, 'Sidecar jest cachowany w LRU — mutacja prelude w miejscu zatrułaby cache. Upewniamy się, że patchPreludeMvhdDuration działa tylko na podanym buforze, a oryginał zostaje niezmieniony.');
    const prelude = makePrelude(1000, 0);
    const copy = Buffer.from(prelude);
    patchPreludeMvhdDuration(copy, 186000);
    expect(readMvhdDuration(prelude)).toBe(0); // original untouched
    expect(readMvhdDuration(copy)).toBeGreaterThan(0);
  });

  it('rounds correctly for non-integer tick count', (ctx) => {
    story(ctx, 'Timescale 44100 Hz i duration 1501ms → 1501/1000*44100 = 66194.1 → round do 66194 ticks.');
    const prelude = makePrelude(44100, 0);
    const copy = Buffer.from(prelude);
    patchPreludeMvhdDuration(copy, 1501);
    expect(readMvhdDuration(copy)).toBe(Math.round(1501 / 1000 * 44100));
  });
});
