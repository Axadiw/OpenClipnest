import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { indexFragmentedMp4, MAX_FRAGMENTS, type RangeFetcher } from './fragmentIndex.js';
import { box, makeFtyp, makeMoov, makeMoofMdat } from './__test-fixtures.js';
import { story } from '../../testing/story.js';

describe('indexFragmentedMp4 (corrupt-fragment guard)', () => {
  it('truncates at the first fragment whose duration exceeds 30 s — Reolink trun bit-flip case', async (ctx) => {
    story(ctx, 'Reolink kamery sporadycznie zapisują bit-flipped sample_duration w trun (zaobserwowane na prod: ~4.3·10^9 ticks zamiast ~320_400 — pojedynczy fragment "trwa" 8 h zamiast 2 s). Wartość propagowała się do sidecar.totalDurationSeconds → events.duration → 8-godzinny pasek w timeline + player utykał w seekPending bo URL ?t=5865s padał daleko poza rzeczywisty content. Walker musi truncate-ować na pierwszym fragmencie z duration > 30 s (Reolink chunk to ~2 s), bo subsequent tfdt też są zatrute — kamera używa bogus duration do liczenia decode_time kolejnego fragmentu, więc całe pole czasu po outlierze jest niewiarygodne.');

    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });

    // Healthy fragment = 3 samples × 3000 ticks = 9000 ticks = 0.1 s at ts=90000.
    // Corrupt fragment = one bit-flipped sample (~3.6 × 10^9 ticks ≈ 40_000 s
    // at ts=90000). The real-world value (4_295_287_696) overflows uint32 —
    // here we stay just under UINT32_MAX so the synthetic trun stays writable.
    const BIT_FLIPPED_SAMPLE_DURATION = 3_600_000_000;
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0,     sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 9000,  sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const fragCorrupt = makeMoofMdat({ trackId: 1, decodeTime: 18000, sampleDurations: [3000, BIT_FLIPPED_SAMPLE_DURATION, 3000], mdatPayloadSize: 64 });
    // Trailing fragments mimic the cascading-corrupted tfdt seen in the real
    // Reolink file (decodeTime jumps by the bogus duration). They must be
    // dropped along with the outlier.
    const frag4 = makeMoofMdat({ trackId: 1, decodeTime: 4_000_000_000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag5 = makeMoofMdat({ trackId: 1, decodeTime: 4_000_009_000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });

    const file = Buffer.concat([ftyp, moov, frag1, frag2, fragCorrupt, frag4, frag5]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const index = await indexFragmentedMp4(file, file.length, fetcher);

    // Only the two healthy pre-outlier fragments survive.
    expect(index.fragments.length).toBe(2);
    // totalTrackDuration covers frag1+frag2 = 18000 ticks @ ts 90000 = 0.2 s.
    expect(index.totalTrackDuration).toBe(18000);
    expect(index.totalTrackDuration / index.moov.primaryTrackTimescale).toBeCloseTo(0.2, 5);
  });

  it('keeps every fragment for a healthy file (no false positives on normal Reolink)', async (ctx) => {
    story(ctx, 'Regression guard: outlier check nie może odciąć zdrowych plików. Standardowy Reolink chunk to ~2 s, próg 30 s daje 15× headroom — żaden normalny fragment się tam nie zmieści.');

    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0,     sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 9000,  sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag3 = makeMoofMdat({ trackId: 1, decodeTime: 18000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const file = Buffer.concat([ftyp, moov, frag1, frag2, frag3]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const index = await indexFragmentedMp4(file, file.length, fetcher);
    expect(index.fragments.length).toBe(3);
    expect(index.totalTrackDuration).toBe(27000); // 3 × 9000
  });

  it('ends the walk at a trailing mfra index instead of rejecting the file', async (ctx) => {
    story(ctx, 'Wiele plików (ffmpeg, a także nagranie pobrane z Clipnest) ma po ostatnim fragmencie blok indeksu mfra. Kiedyś indekser oczekiwał tam moof, rzucał błąd i nagranie lądowało jako nieodtwarzalne. Teraz mfra kończy przegląd: wszystkie fragmenty zostają, a nasz własny mfra i tak dokłada sidecar.');

    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0,    sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 9000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const mfra = box('mfra', Buffer.alloc(32));
    const file = Buffer.concat([ftyp, moov, frag1, frag2, mfra]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const index = await indexFragmentedMp4(file, file.length, fetcher);
    expect(index.fragments.length).toBe(2);
    expect(index.totalTrackDuration).toBe(18000);
    expect(index.mdatSpanEnd).toBe(file.length - mfra.length);
  });

  it('still rejects an unexpected box between fragments', async (ctx) => {
    story(ctx, 'Tylko mfra po ostatnim fragmencie jest akceptowane. Obcy blok w środku pliku albo mfra przed jakimkolwiek fragmentem dalej oznacza uszkodzony plik.');

    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0,
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const junk = box('udta', Buffer.alloc(16));
    const midFile = Buffer.concat([ftyp, moov, frag1, junk, frag1]);
    await expect(indexFragmentedMp4(midFile, midFile.length, async (s, e) => midFile.slice(s, e + 1)))
      .rejects.toThrow(/expected moof/);
    const mfraFirst = Buffer.concat([ftyp, moov, box('mfra', Buffer.alloc(16)), frag1]);
    await expect(indexFragmentedMp4(mfraFirst, mfraFirst.length, async (s, e) => mfraFirst.slice(s, e + 1)))
      .rejects.toThrow(/expected moof/);
  });
});

describe('indexFragmentedMp4 (allocation guards — crafted-MP4 OOM defense)', () => {
  const ftyp = makeFtyp();
  const goodMoov = () => makeMoov({
    mvhdTimescale: 1000,
    mvhdDuration: 0,
    tracks: [{ id: 1, mdhdTimescale: 90000 }],
    withMvex: true,
    withMehd: false,
    trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
  });

  it('MAX_FRAGMENTS is a generous but bounded ceiling', (ctx) => {
    story(ctx, 'MAX_FRAGMENTS musi być na tyle duży, żeby żaden realny plik (nawet skrajnie długie nagranie) się nie obciął, ale skończony, żeby crafted plik nie mógł nas zajechać pamięcią. ~500k daje 5.7× zapasu nad 24 h nagrania przy 1 fragmencie/s, a i tak trzyma retencję FragmentRefów w ~75 MB.');
    expect(MAX_FRAGMENTS).toBeGreaterThanOrEqual(100_000);
    expect(Number.isFinite(MAX_FRAGMENTS)).toBe(true);
  });

  it('bounds allocation on a file crafted from minimal zero-duration [moof][mdat] atoms', async (ctx) => {
    story(ctx, 'Sedno: plik zbudowany z minimalnych par [moof(8)][mdat(8)] pakuje ~67M granic fragmentów w 1 GB → ~10 GB sterty i OOM całego pod-a thumbnail-workera (4 GiB), zabijając ~15 innych jednoczesnych jobów userów. Header-only moof nie ma primary traf → parser zwraca fragment o duration 0, który przechodził stary guard (0 nigdy nie jest > 30 s) i akumulował się bez końca. Teraz duration <= 0 jest traktowane jak korupcja i walker ucina się na pierwszym takim fragmencie — zero akumulacji, zamiast gigantycznej tablicy.');

    const minimalMoof = box('moof', Buffer.alloc(0)); // 8-byte header-only moof
    const minimalMdat = box('mdat', Buffer.alloc(0)); // 8-byte header-only mdat
    const atomPair = Buffer.concat([minimalMoof, minimalMdat]);
    // Many atoms in the buffer — the guard must stop us long before we index them.
    const flood = Buffer.concat(Array.from({ length: 10_000 }, () => atomPair));
    const file = Buffer.concat([ftyp, goodMoov(), flood]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const index = await indexFragmentedMp4(file, file.length, fetcher);
    // Truncated at the very first zero-duration fragment — no giant array.
    expect(index.fragments.length).toBe(0);
  });

  it('fails closed (throws) when the fragment count exceeds the cap', async (ctx) => {
    story(ctx, 'Backstop na wypadek fragmentów z niezerowym, ale malutkim duration (obejście guardu zero-duration): twardy limit liczby fragmentów. Po przekroczeniu MAX_FRAGMENTS rzucamy błąd, który caller obsługuje jak plik nie do przetworzenia — zamiast dalej alokować FragmentRefy w nieskończoność.');

    // Healthy tiny fragments: 3000 ticks @ ts=90000 = 0.033 s each — positive
    // (passes the zero-duration guard) and well under 30 s (passes the outlier
    // guard), so only the count cap can stop the walk.
    const frags: Buffer[] = [];
    let dt = 0;
    for (let i = 0; i < 120; i++) {
      frags.push(makeMoofMdat({ trackId: 1, decodeTime: dt, sampleDurations: [3000], mdatPayloadSize: 8 }));
      dt += 3000;
    }
    const file = Buffer.concat([ftyp, goodMoov(), ...frags]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    // Inject a small cap so we can assert the throw without building 500k frags.
    await expect(indexFragmentedMp4(file, file.length, fetcher, 100)).rejects.toThrow(/MAX_FRAGMENTS/);
  });

  it('does NOT throw for a normal fragment count under the injected cap (no false positive)', async (ctx) => {
    story(ctx, 'Regression guard: limit liczby fragmentów nie może odrzucać zdrowych plików mieszczących się pod capem. 3 fragmenty przy capie 100 przechodzą w całości.');

    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0,     sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 9000,  sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const frag3 = makeMoofMdat({ trackId: 1, decodeTime: 18000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 64 });
    const file = Buffer.concat([ftyp, goodMoov(), frag1, frag2, frag3]);
    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const index = await indexFragmentedMp4(file, file.length, fetcher, 100);
    expect(index.fragments.length).toBe(3);
  });
});
