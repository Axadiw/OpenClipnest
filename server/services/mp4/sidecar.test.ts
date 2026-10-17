import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import {
  buildSidecar,
  parseSidecar,
  readDurationSecondsFromPrelude,
  SIDECAR_V6_MARKER,
} from './sidecar.js';
import { box, makeFtyp, makeMoov, makeMoofMdat } from './__test-fixtures.js';
import { buildSidecarForFile } from './sidecarBuilder.js';
import type { RangeFetcher } from './fragmentIndex.js';
import { story } from '../../testing/story.js';

describe('parseSidecar — retired v5 sidecar back-compat', () => {
  it('parses a lingering v5 sidecar as v4 (retired marker treated as unknown trailer, no throw)', (ctx) => {
    story(
      ctx,
      'Trailer v5 (marker 0x76352e30 + count + tabela per-fragment max-duration) został wycofany — worker emituje już tylko v6, a buildSidecar nie potrafi go zapisać. Ale stare v5 sidekarze nadal leżą w S3. parseSidecar nie zna markera v5, więc trafia na gałąź "unknown trailer → break" i zwraca czysty v4: prelude + mfra + durationMs, perTrack undefined. Serve path i tak czytał wyłącznie perTrack, więc taki sidecar dostaje direct-playback fallback (= zachowanie sprzed usunięcia), a reconciler przepieka go do v6. Kluczowe: żaden v5 sidecar nie wywala parsera.',
    );
    // Hand-build the retired v5 wire format — buildSidecar can no longer emit it:
    //   [v4 sidecar][u32 V5_MARKER=0x76352e30][u32 count][u32 ticks × count]
    const prelude = Buffer.from([10, 20, 30]);
    const mfra = Buffer.from('mm', 'utf8');
    const ticks = [100, 200, 300];
    const v4 = buildSidecar(prelude, mfra, 42000); // valid v4 prefix
    const v5Tail = Buffer.alloc(4 + 4 + ticks.length * 4);
    let q = 0;
    v5Tail.writeUInt32BE(0x76352e30, q); q += 4; // retired V5_MARKER
    v5Tail.writeUInt32BE(ticks.length, q); q += 4;
    for (const t of ticks) { v5Tail.writeUInt32BE(t, q); q += 4; }
    const legacyV5 = Buffer.concat([v4, v5Tail]);

    const out = parseSidecar(legacyV5);
    expect(out.prelude).toEqual(prelude);
    expect(out.mfra).toEqual(mfra);
    expect(out.durationMs).toBe(42000);
    expect(out.perTrack).toBeUndefined();
  });
});

describe('buildSidecar / parseSidecar — v6 (per-track per-fragment durations)', () => {
  it('round-trips a v6 sidecar with two tracks × N fragments', (ctx) => {
    story(
      ctx,
      'V6 trailer niesie per-track per-fragment durations (każdy w swoim timescale). Server używa tego do emitowania OSOBNEGO sidx-a per track — to dokładnie ta struktura, która w teście z ffmpeg-em +dash+global_sidx pozwoliła Chrome\'owi zejść z 85 requestów / 9s do 3 requestów / 0.36s na 100MB pliku Reolinka.',
    );
    const prelude = Buffer.from([0xff, 0xee, 0xdd]);
    const mfra = Buffer.from('mfra-bytes-here', 'utf8');
    const sidecar = buildSidecar(prelude, mfra, 12345, [
      { trackId: 1, timescale: 150000, perFragmentTicks: [300000, 290000, 310000] },
      { trackId: 2, timescale: 16000, perFragmentTicks: [31744, 30720, 32768] },
    ]);
    const out = parseSidecar(sidecar);
    expect(out.prelude).toEqual(prelude);
    expect(out.mfra).toEqual(mfra);
    expect(out.durationMs).toBe(12345);
    expect(out.perTrack).toEqual([
      { trackId: 1, timescale: 150000, perFragmentTicks: [300000, 290000, 310000] },
      { trackId: 2, timescale: 16000, perFragmentTicks: [31744, 30720, 32768] },
    ]);
  });

  it('v6 marker constant is stable (do not change without schema bump)', (ctx) => {
    story(
      ctx,
      'Marker rozróżnia v6 od dowolnego u32 duration_ms. Każda zmiana = wszystkie istniejące v6 sidekarze stają się "obce" → re-bake. Pin & document.',
    );
    expect(SIDECAR_V6_MARKER).toBe(0x76362e30);
  });

  it('refuses to emit v6 trailer when durationMs is missing', (ctx) => {
    story(
      ctx,
      'Bez durationMs anchor server nie wie jak ustawić sidx total duration. Lepiej fail-fast.',
    );
    expect(() =>
      buildSidecar(
        Buffer.alloc(4),
        Buffer.alloc(4),
        undefined,
        [{ trackId: 1, timescale: 90000, perFragmentTicks: [100] }],
      ),
    ).toThrow(/requires durationMs/);
  });

  it('refuses to emit v6 trailer when tracks have mismatched fragment counts', (ctx) => {
    story(
      ctx,
      'Wszystkie tracky muszą mieć tę samą liczbę fragmentów (= N moofs). Inaczej dual-sidx-y w serwowanym pliku rozjadą się i Chrome zarzuci PIPELINE_ERROR. Fail-fast podczas build.',
    );
    expect(() =>
      buildSidecar(
        Buffer.alloc(4),
        Buffer.alloc(4),
        1000,
        [
          { trackId: 1, timescale: 90000, perFragmentTicks: [100, 200, 300] },
          { trackId: 2, timescale: 16000, perFragmentTicks: [50, 100] },
        ],
      ),
    ).toThrow(/v6 track 2 has 2 fragments, expected 3/);
  });

  it('parser stops at unknown future marker without throwing (forward-compat)', (ctx) => {
    story(
      ctx,
      'Jeśli kiedyś dorzucimy v7 trailer, stary v0.10.210 parser musi zwrócić v4/v6 fields które rozumie, a v7 zignorować. Inaczej każdy schema bump = downtime na zdeployowanie nowych parserów wszędzie zanim worker zacznie emitować nowy trailer.',
    );
    const v6 = buildSidecar(
      Buffer.from([1]),
      Buffer.from([2]),
      500,
      [{ trackId: 1, timescale: 1000, perFragmentTicks: [100] }],
    );
    // Append a synthetic "v7" marker (= 'v7.0' big-endian) + 4 trailing bytes.
    const fakeV7Marker = 0x76372e30;
    const withFutureTrailer = Buffer.concat([
      v6,
      Buffer.from([
        (fakeV7Marker >>> 24) & 0xff,
        (fakeV7Marker >>> 16) & 0xff,
        (fakeV7Marker >>> 8) & 0xff,
        fakeV7Marker & 0xff,
        0xde, 0xad, 0xbe, 0xef,
      ]),
    ]);
    const out = parseSidecar(withFutureTrailer);
    expect(out.durationMs).toBe(500);
    expect(out.perTrack).toEqual([{ trackId: 1, timescale: 1000, perFragmentTicks: [100] }]);
  });
});

describe('buildSidecar / parseSidecar', () => {
  it('round-trips prelude + mfra', (ctx) => {
    story(ctx, 'Format kontenerowy sidecara to czyste TLV — pack + unpack zachowuje bajty.');
    const prelude = Buffer.from([1, 2, 3, 4, 5]);
    const mfra = Buffer.from('hello world!', 'utf8');
    const packed = buildSidecar(prelude, mfra);
    const out = parseSidecar(packed);
    expect(out.prelude).toEqual(prelude);
    expect(out.mfra).toEqual(mfra);
  });

  it('throws on truncated input', () => {
    expect(() => parseSidecar(Buffer.alloc(4))).toThrow();
  });
});

describe('readDurationSecondsFromPrelude', () => {
  it('recovers duration from a patched mvhd in a prelude', (ctx) => {
    story(
      ctx,
      'Po wygenerowaniu sidecara prawdziwy total duration siedzi już w mvhd.duration patched moova. Czytamy go bez ponownego skanowania fragmentów — to pojedynczy GET ~5KB sidecara wystarcza do odzyskania duration dla setek tysięcy starych eventów z błędną wartością z head-only ffmpeg.',
    );
    const ftyp = makeFtyp();
    // mvhd v0: timescale=1000, duration=96358 → 96.358 s — kosmiczna wartość
    // realistyczna dla 1:36 klipu z Reolinka (ten sam case co w prod debugu).
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 96358,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const prelude = Buffer.concat([ftyp, moov]);
    const sec = readDurationSecondsFromPrelude(prelude);
    expect(sec).not.toBeNull();
    expect(sec!).toBeCloseTo(96.358, 3);
  });

  it('returns null when mvhd is missing or duration is zero', (ctx) => {
    story(
      ctx,
      'Degenerated prelude — np. uszkodzony sidecar albo class B pre-patch z mvhd.duration=0 — nie może udawać że zna duration. null = "zostaw events.duration jak jest", nie nadpisuj zerem.',
    );
    // 1) prelude bez mvhd (moov bez dzieci)
    const ftyp = makeFtyp();
    const emptyMoov = box('moov', Buffer.alloc(0));
    const noMvhd = Buffer.concat([ftyp, emptyMoov]);
    expect(readDurationSecondsFromPrelude(noMvhd)).toBeNull();

    // 2) prelude z mvhd duration=0 (Reolink przed patchem)
    const moovZero = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
    });
    const zeroPrelude = Buffer.concat([ftyp, moovZero]);
    expect(readDurationSecondsFromPrelude(zeroPrelude)).toBeNull();

    // 3) bufer bez ftyp — nawet header nie czytelny
    expect(readDurationSecondsFromPrelude(Buffer.alloc(8))).toBeNull();
  });

  it('round-trips duration via buildSidecarForFile → parseSidecar trailing field', async (ctx) => {
    story(
      ctx,
      'v4 invariant: buildSidecarForFile zapisuje totalDurationSeconds w trailing u32 ms field, parseSidecar zwraca to jako durationMs. mvhd.duration zostaje 0 (Reolink default) — sidecar carries duration explicitly out-of-band, nie w moov. To pozwala getDurationSecondsFromExistingSidecar zachować recovery flow bez patching mvhd (które łamało iOS WebKit).',
    );
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 256 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 9000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 256 });
    const file = Buffer.concat([ftyp, moov, frag1, frag2]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const result = await buildSidecarForFile(file, file.length, fetcher);
    expect(result.classification.class).toBe('A');
    const expected = result.totalDurationSeconds!;

    const parsed = parseSidecar(result.sidecar!);
    expect(parsed.durationMs).toBeDefined();
    const recoveredSec = parsed.durationMs! / 1000;
    // Round-trip via u32 ms quantises to ±0.5ms; tolerance 1ms is generous.
    expect(Math.abs(recoveredSec - expected)).toBeLessThan(0.001);

    // mvhd.duration in the patched prelude is intentionally 0 — recovery via
    // mvhd would return null (which is the trigger to fall through to the
    // trailing-field path in getDurationSecondsFromExistingSidecar).
    expect(readDurationSecondsFromPrelude(parsed.prelude)).toBeNull();
  });

  it('parseSidecar handles legacy format (no trailing duration) for backward compat', () => {
    const prelude = Buffer.from('prelude-bytes');
    const mfra = Buffer.from('mfra-bytes');
    const legacy = buildSidecar(prelude, mfra); // no duration
    const parsed = parseSidecar(legacy);
    expect(parsed.durationMs).toBeUndefined();
    expect(parsed.prelude.equals(prelude)).toBe(true);
    expect(parsed.mfra.equals(mfra)).toBe(true);
  });
});
