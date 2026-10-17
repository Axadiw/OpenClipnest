import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { buildMfra, parseMfraEntries, shiftMfraOffsets, computeSidxSize, buildSidx } from './seekTables.js';
import { readBoxHeader } from './boxes.js';
import type { FragmentRef } from './fragmentIndex.js';
import { story } from '../../testing/story.js';

describe('buildMfra', () => {
  it('emits one tfra entry per fragment + mfro at end', (ctx) => {
    story(ctx, 'Mfra ma tfra z 3 wpisami i mfro deklarujące własny rozmiar — to wystarcza przeglądarce do natywnego seek.');
    const fragments: FragmentRef[] = [
      { moofFileOffset: 1000, moofSize: 200, mdatSize: 1024, decodeTime: 0, duration: 90000, sampleCount: 30 },
      { moofFileOffset: 2224, moofSize: 200, mdatSize: 2048, decodeTime: 90000, duration: 90000, sampleCount: 30 },
      { moofFileOffset: 4472, moofSize: 200, mdatSize: 1024, decodeTime: 180000, duration: 90000, sampleCount: 30 },
    ];
    const mfra = buildMfra(fragments, 1, 0);
    const hdr = readBoxHeader(mfra, 0);
    expect(hdr?.type).toBe('mfra');
    expect(hdr?.size).toBe(mfra.length);

    const tfra = readBoxHeader(mfra, 8);
    expect(tfra?.type).toBe('tfra');
    // tfra payload: version+flags(4) track_id(4) reserved(4) entry_count(4)
    const entryCount = mfra.readUInt32BE(8 + 8 + 4 + 4 + 4);
    expect(entryCount).toBe(3);

    // mfro at end
    const mfroOffset = mfra.length - 16;
    const mfro = readBoxHeader(mfra, mfroOffset);
    expect(mfro?.type).toBe('mfro');
    // mfro carries total mfra size as last 4 bytes
    expect(mfra.readUInt32BE(mfra.length - 4)).toBe(mfra.length);
  });
});

describe('parseMfraEntries / shiftMfraOffsets', () => {
  const fragments: FragmentRef[] = [
    { moofFileOffset: 1000, moofSize: 200, mdatSize: 1024, decodeTime: 0,      duration: 90000, sampleCount: 30 },
    { moofFileOffset: 2224, moofSize: 200, mdatSize: 2048, decodeTime: 90000,  duration: 90000, sampleCount: 30 },
    { moofFileOffset: 4472, moofSize: 200, mdatSize: 1024, decodeTime: 180000, duration: 90000, sampleCount: 30 },
  ];

  it('parseMfraEntries round-trips what buildMfra wrote', (ctx) => {
    story(ctx, 'sidx generator nie ma dostępu do oryginalnego FragmentRef[] przy serwowaniu (sidecar trzyma tylko mfra). Parser pozwala wyciągnąć (decodeTime, moofOffset) z mfra przy każdym requeście bez bumpa schema sidekarza.');
    const mfra = buildMfra(fragments, 1, 100);
    const entries = parseMfraEntries(mfra);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ decodeTime: 0,      moofOffset: 1100 });
    expect(entries[1]).toEqual({ decodeTime: 90000,  moofOffset: 2324 });
    expect(entries[2]).toEqual({ decodeTime: 180000, moofOffset: 4572 });
  });

  it('parseMfraEntries rejects non-mfra buffer', () => {
    expect(() => parseMfraEntries(Buffer.alloc(64))).toThrow(/mfra/);
  });

  it('shiftMfraOffsets adds delta to every moof_offset, leaves decodeTime untouched', (ctx) => {
    story(ctx, 'Po wstrzyknięciu sidx między prelude a pierwszy moof, KAŻDY moof_offset w mfra musi się przesunąć o sidxLen — inaczej iOS WebKit (który używa mfra do seeków) trafia w środek mdat zamiast w nagłówek moof, scrubbing zwraca uszkodzone klatki.');
    const mfra = buildMfra(fragments, 1, 0);
    const shifted = shiftMfraOffsets(mfra, 1843);
    // Bytes outside the offset fields untouched — header/footer same.
    expect(shifted.slice(0, 32)).toEqual(mfra.slice(0, 32));
    expect(shifted.slice(-16)).toEqual(mfra.slice(-16)); // mfro at end
    const entries = parseMfraEntries(shifted);
    expect(entries.map(e => e.moofOffset)).toEqual([1000 + 1843, 2224 + 1843, 4472 + 1843]);
    expect(entries.map(e => e.decodeTime)).toEqual([0, 90000, 180000]);
  });

  it('shiftMfraOffsets with delta=0 returns equal-content fresh buffer', (ctx) => {
    story(ctx, 'Caller na hot-pathie nie musi gałęzić "shift==0 to skip" — bezpiecznie callować zawsze. Zwracamy fresh copy żeby kaller mógł trzymać oba (cached pre-shift + post-shift dla response) bez aliasing.');
    const mfra = buildMfra(fragments, 1, 50);
    const out = shiftMfraOffsets(mfra, 0);
    expect(out).toEqual(mfra);
    expect(out).not.toBe(mfra); // fresh buffer
  });
});

describe('computeSidxSize / buildSidx', () => {
  it('computeSidxSize matches actual sidx box size for N=1, 3, 200', (ctx) => {
    story(ctx, 'Caller potrzebuje znać sidxLen ZANIM go wygeneruje — żeby pre-shiftować mfra offsety i Content-Length. Sanity: zwrócona prognoza musi byc bit-identyczna z .length wygenerowanego buffera.');
    for (const n of [1, 3, 200]) {
      const entries = Array.from({ length: n }, (_, i) => ({ decodeTime: i * 90000, moofOffset: 1000 + i * 1000 }));
      const sidx = buildSidx({
        entries, primaryTrackId: 1, timescale: 90000,
        mdatZoneEnd: 1000 + n * 1000,
        totalDurationTicks: n * 90000,
      });
      expect(sidx.length).toBe(computeSidxSize(n));
    }
  });

  it('emits a valid sidx box header with reference_count = fragment count', (ctx) => {
    story(ctx, 'Chrome MSE czyta najpierw header + reference_count z sidx żeby zaalokować internal seek-table. Jeśli count nie zgadza się z faktyczną liczbą referencji, Chrome rzuca DEMUXER_ERROR_COULD_NOT_PARSE i pokazuje "Loading video..." na zawsze. Test pilnuje że count we are write się zgadza.');
    const entries = [
      { decodeTime: 0,      moofOffset: 1000 },
      { decodeTime: 90000,  moofOffset: 2224 },
      { decodeTime: 180000, moofOffset: 4472 },
    ];
    const sidx = buildSidx({
      entries, primaryTrackId: 1, timescale: 90000,
      mdatZoneEnd: 5496, totalDurationTicks: 270000,
    });
    const hdr = readBoxHeader(sidx, 0);
    expect(hdr?.type).toBe('sidx');
    expect(hdr?.size).toBe(sidx.length);
    // version (byte 8) = 1; reference_count is at offset 8 + 4 + 4 + 4 + 8 + 8 + 2 = 38
    expect(sidx.readUInt8(8)).toBe(1);
    expect(sidx.readUInt16BE(38)).toBe(3);
    // first reference: type+size at byte 40, size = 2224-1000 = 1224
    expect(sidx.readUInt32BE(40) & 0x7fffffff).toBe(1224);
    // first reference subsegment_duration at byte 44 = 90000
    expect(sidx.readUInt32BE(44)).toBe(90000);
    // SAP flags at byte 48 — type=0x90000000 (SAP at first sample, SAP_type=1)
    expect(sidx.readUInt32BE(48)).toBe(0x90000000);
  });

  it('last subsegment derives size from mdatZoneEnd and duration from totalDurationTicks', (ctx) => {
    story(ctx, 'mfra trzyma tylko (decodeTime, offset) — bez explicit size/duration. Ostatni fragment domykamy w sidx parametrami callera: mdatZoneEnd (size) + totalDurationTicks (duration). Bez tego ostatni fragment w sidx miałby size=0 albo undefined i Chrome by truncated odtwarzanie.');
    const sidx = buildSidx({
      entries: [
        { decodeTime: 0,      moofOffset: 1000 },
        { decodeTime: 90000,  moofOffset: 2000 },
        { decodeTime: 180000, moofOffset: 3500 },
      ],
      primaryTrackId: 1, timescale: 90000,
      mdatZoneEnd: 6000,        // last frag size = 6000-3500 = 2500
      totalDurationTicks: 295000, // last frag duration = 295000-180000 = 115000
    });
    // 3rd reference starts at byte 40 + 2*12 = 64
    const refSize = sidx.readUInt32BE(64) & 0x7fffffff;
    const refDur = sidx.readUInt32BE(68);
    expect(refSize).toBe(2500);
    expect(refDur).toBe(115000);
  });

  it('throws on non-positive subsegment size or duration (corrupt mfra)', (ctx) => {
    story(ctx, 'Fail-fast jest tu krytyczny: zła sidx = Chrome zamiast pokazać błąd schowa się w "Loading video..." na zawsze. Lepsza 5xx z explicit message niż nieskończony spinner po stronie klienta.');
    expect(() => buildSidx({
      entries: [
        { decodeTime: 0,     moofOffset: 1000 },
        { decodeTime: 90000, moofOffset: 1000 }, // same offset = size 0
      ],
      primaryTrackId: 1, timescale: 90000, mdatZoneEnd: 2000, totalDurationTicks: 180000,
    })).toThrow(/non-positive subsegment size/);

    expect(() => buildSidx({
      entries: [
        { decodeTime: 0, moofOffset: 1000 },
        { decodeTime: 0, moofOffset: 2000 }, // same decodeTime = duration 0
      ],
      primaryTrackId: 1, timescale: 90000, mdatZoneEnd: 3000, totalDurationTicks: 90000,
    })).toThrow(/non-positive subsegment duration/);
  });

  it('uses explicitDurationTicks verbatim when provided (v0.10.204 max-dur path)', (ctx) => {
    story(
      ctx,
      'Per-fragment max(videoDur, audioDur) z v5 sidekarza musi trafić do sidx 1:1, bo gdyby buildSidx wpadł w fallback (decodeTime delta) to skończyłoby się v0.10.201-em — primary-track-only durationy nie pokrywają realnego movie duration na multi-tracku.',
    );
    const sidx = buildSidx({
      entries: [
        { decodeTime: 0,      moofOffset: 1000, explicitDurationTicks: 120000 },
        { decodeTime: 90000,  moofOffset: 2000, explicitDurationTicks: 130000 },
        { decodeTime: 180000, moofOffset: 3500, explicitDurationTicks: 140000 },
      ],
      primaryTrackId: 1, timescale: 90000,
      mdatZoneEnd: 5500, totalDurationTicks: 295000,
    });
    // First reference subsegment_duration at byte 44 = 120000 (explicit)
    // NOT 90000 (delta from next decodeTime)
    expect(sidx.readUInt32BE(44)).toBe(120000);
    // 2nd ref at 44 + 12 = 56: 130000
    expect(sidx.readUInt32BE(56)).toBe(130000);
    // 3rd ref at 68: 140000
    expect(sidx.readUInt32BE(68)).toBe(140000);
  });

  it('single-reference sidx covers entire mdat zone with one subsegment (v0.10.208 Option A2)', (ctx) => {
    story(
      ctx,
      'Multi-track Reolink fmp4 trafia w sidx z reference_count=1 — Chrome dostaje duration anchor + offset anchor bez per-fragment durationów (które na multi-tracku zaniżały sumę). Test pilnuje że buildSidx z N=1 wkleja explicitDurationTicks=totalTicks i size=mdatZoneEnd-moofOffset.',
    );
    const FIRST_MOOF = 2048;
    const MDAT_END = 1_234_567;
    const TOTAL_TICKS = 9_000_000; // 100s @ 90kHz
    const sidx = buildSidx({
      entries: [
        { decodeTime: 0, moofOffset: FIRST_MOOF, explicitDurationTicks: TOTAL_TICKS },
      ],
      primaryTrackId: 1,
      timescale: 90000,
      mdatZoneEnd: MDAT_END,
      totalDurationTicks: TOTAL_TICKS,
    });
    expect(sidx.length).toBe(computeSidxSize(1));
    // Layout: 8 hdr + 4 ver/flags + 4 refID + 4 ts + 8 ept + 8 firstOff = 36
    // then 2 reserved + 2 reference_count at 38 = first reference at byte 40.
    expect(sidx.readUInt16BE(38)).toBe(1);
    // first reference: size at 40, top bit = type=0 (movie-fragment).
    const refSize = sidx.readUInt32BE(40) & 0x7fffffff;
    expect(refSize).toBe(MDAT_END - FIRST_MOOF);
    // subsegment_duration at 44.
    expect(sidx.readUInt32BE(44)).toBe(TOTAL_TICKS);
    // SAP flags at 48: 0x90000000 (starts_with_SAP=1, SAP_type=1).
    expect(sidx.readUInt32BE(48)).toBe(0x90000000);
  });
});
