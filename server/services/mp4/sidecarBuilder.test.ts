import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildSidecarForFile, frameRateFromIndex } from './sidecarBuilder.js';
import { parseSidecar } from './sidecar.js';
import { readBoxHeader } from './boxes.js';
import { inspectMoov } from './moov.js';
import type { RangeFetcher, IndexResult } from './fragmentIndex.js';
import { makeFtyp, makeMoov, makeMoofMdat } from './__test-fixtures.js';
import { story } from '../../testing/story.js';

// ---------------------------------------------------------------------------
// End-to-end test — synthesize a Reolink-style fragmented mp4 and verify
// buildSidecarForFile produces a sidecar that, when stitched in front,
// yields a structurally valid fMP4 with mehd + mfra.
// ---------------------------------------------------------------------------

describe('buildSidecarForFile (synthesized fragmented mp4)', () => {
  it('produces a same-size prelude with mvhd.duration=0 + valid mfra + trailing durationMs', async (ctx) => {
    story(ctx, 'End-to-end v4: bierzemy własnoręcznie zlepiony Reolink-style fMP4, generujemy sidecar i sprawdzamy że (a) sklejony [prelude][mdat zone][mfra] ma poprawną strukturę i seek table, (b) prelude jest dokładnie tej samej długości co [ftyp][orig moov], (c) mvhd.duration ZOSTAJE 0 (vs. v2/v3 gdzie był nadpisywany — to było źródło iOS 2× bugu), (d) duration siedzi w trailing u32 ms field.');
    const ftyp = makeFtyp();
    const moov = makeMoov({
      mvhdTimescale: 1000,
      mvhdDuration: 0, // nieznany, jak w Reolink
      tracks: [{ id: 1, mdhdTimescale: 90000 }],
      withMvex: true,
      withMehd: false,
      trexDefaults: [{ trackId: 1, defaultSampleDuration: 3000 }],
    });
    const frag1 = makeMoofMdat({ trackId: 1, decodeTime: 0, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 256 });
    const frag2 = makeMoofMdat({ trackId: 1, decodeTime: 9000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 256 });
    const frag3 = makeMoofMdat({ trackId: 1, decodeTime: 18000, sampleDurations: [3000, 3000, 3000], mdatPayloadSize: 256 });
    const file = Buffer.concat([ftyp, moov, frag1, frag2, frag3]);

    const fetcher: RangeFetcher = async (start, end) => file.slice(start, end + 1);

    const result = await buildSidecarForFile(file, file.length, fetcher);
    expect(result.classification.class).toBe('A');
    expect(result.sidecar).toBeTruthy();
    expect(result.totalDurationSeconds).toBeCloseTo(27000 / 90000, 5); // 3 × 3 × 3000 / 90000 = 0.3 s
    // 9 total video samples (3 frags × 3 each) / 0.3 s = 30 fps average
    expect(result.frameRate).toBeCloseTo(9 / 0.3, 5);

    const { prelude, mfra, durationMs } = parseSidecar(result.sidecar!);

    // Prelude must be EXACTLY [ftyp][orig moov size] — no growth.
    expect(prelude.length).toBe(ftyp.length + moov.length);
    const ftypHdr = readBoxHeader(prelude, 0);
    expect(ftypHdr?.type).toBe('ftyp');
    const patchedMoovHdr = readBoxHeader(prelude, ftypHdr!.size);
    expect(patchedMoovHdr?.type).toBe('moov');
    expect(patchedMoovHdr?.size).toBe(moov.length);
    const reinspect = inspectMoov(prelude);
    // No mehd is added.
    expect(reinspect.moov.hasMehd).toBe(false);
    // mvhd duration is intentionally LEFT at 0 (Reolink default) — see
    // patchMoovDurationsInPlace jsdoc for the iOS double-count rationale.
    const mvhdDurationOff = ftyp.length + 8 /*moov hdr*/ + 8 /*mvhd hdr*/ + 4 /*ver+flags*/ + 8 /*creation+mod v0*/ + 4 /*timescale*/;
    expect(prelude.readUInt32BE(mvhdDurationOff)).toBe(0);
    // Duration now lives in the trailing u32 ms field. 0.3 s → 300 ms.
    expect(durationMs).toBe(300);

    // mfra must be valid
    const mfraHdr = readBoxHeader(mfra, 0);
    expect(mfraHdr?.type).toBe('mfra');
    const tfraHdr = readBoxHeader(mfra, 8);
    expect(tfraHdr?.type).toBe('tfra');

    // Synthesize what the API will emit: prelude + raw mdat zone + mfra
    const mdatZoneStart = ftyp.length + moov.length;
    const mdatZone = file.slice(mdatZoneStart);
    const stitched = Buffer.concat([prelude, mdatZone, mfra]);

    // Walk top-level boxes — should be ftyp, moov, moof×3 + mdat×3, mfra
    const boxes: string[] = [];
    let off = 0;
    while (off < stitched.length) {
      const h = readBoxHeader(stitched, off);
      if (!h || h.size <= 0) break;
      boxes.push(h.type);
      off += h.size;
    }
    expect(boxes[0]).toBe('ftyp');
    expect(boxes[1]).toBe('moov');
    expect(boxes[boxes.length - 1]).toBe('mfra');
    expect(boxes.filter((b) => b === 'moof').length).toBe(3);
    expect(boxes.filter((b) => b === 'mdat').length).toBe(3);
  });

  it('emits a v6 trailer carrying per-track per-fragment durations', async (ctx) => {
    story(ctx, 'Regression guard for the v6 emit path: buildSidecarForFile MUSI dołożyć trailer v6 (perTrack) do sidecara, bo to on napędza dual-sidx serve path i <1s cold-start w Chrome. Bug-class którego pilnuje: gdyby ktoś zawołał buildSidecar gubiąc argument perTrack (np. zostawiając stary `undefined` placeholder po wycofaniu v5), powstałby sidecar v4-only — HLS-endpointy zwracałyby 409 "v6 sidecar required" i każde świeżo przetworzone wideo spadłoby na wolny direct-playback fallback. parseSidecar.perTrack === undefined złapie to natychmiast.');
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

    const { perTrack } = parseSidecar(result.sidecar!);
    // One track (id 1) in its own mdhd timescale, one duration per fragment
    // (3 samples × 3000 ticks = 9000 ticks each).
    expect(perTrack).toEqual([
      { trackId: 1, timescale: 90000, perFragmentTicks: [9000, 9000] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests against real Reolink fixtures (skipped if directory absent — keeps
// CI green even without the local fixtures cache).
// ---------------------------------------------------------------------------

const REOLINK_DIR = path.join(os.homedir(), 'Downloads', 'nagrania reolink');

async function findReolinkFixture(): Promise<string | null> {
  try {
    const stat = await fs.stat(REOLINK_DIR);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  // Walk recursively, return first .mp4 we find under ~5 MB to keep tests fast
  async function walk(dir: string): Promise<string | null> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await walk(full);
        if (sub) return sub;
      } else if (e.isFile() && e.name.endsWith('.mp4')) {
        const s = await fs.stat(full);
        if (s.size < 5 * 1024 * 1024) return full;
      }
    }
    return null;
  }
  return walk(REOLINK_DIR);
}

describe('buildSidecarForFile (real Reolink fixture)', () => {
  it('classifies real Reolink mp4 as A and emits a non-trivial sidecar', async (ctx) => {
    story(ctx, 'Realny plik z kamery (Reolink fragmented mp4) musi być zaklasyfikowany jako A i wygenerować sidecar; prelude ma rozmiar ftyp+orig_moov (bez przesunięcia, by nie zepsuć absolutnych offsetów w tfhd). Po v4 mvhd.duration zostaje 0 — duration jest w trailing field sidecara.');
    const fixture = await findReolinkFixture();
    if (!fixture) {
      ctx.skip();
      return;
    }
    const data = await fs.readFile(fixture);
    const fetcher: RangeFetcher = async (start, end) => data.slice(start, end + 1);
    const result = await buildSidecarForFile(data, data.length, fetcher);

    expect(result.classification.class).toBe('A');
    expect(result.sidecar).toBeTruthy();
    expect(result.sidecar!.length).toBeGreaterThan(100);
    expect(result.totalDurationSeconds!).toBeGreaterThan(0);

    const { prelude, mfra } = parseSidecar(result.sidecar!);

    // Prelude must NOT grow vs original.
    const origInspect = inspectMoov(data);
    expect(prelude.length).toBe(origInspect.ftypSize + origInspect.moov.moovSize);

    // Patched moov: same size, mehd still absent (we don't add it), durations populated.
    const reinspect = inspectMoov(prelude);
    expect(reinspect.moov.moovSize).toBe(origInspect.moov.moovSize);
    expect(reinspect.moov.hasMehd).toBe(false);

    const mfraHdr = readBoxHeader(mfra, 0);
    expect(mfraHdr?.type).toBe('mfra');

    // If the source happened to carry an `edts/elst` (which some Reolink
    // firmwares emit), after patching it must have entry_count = 0 (empty
    // edit list = "use tkhd / media samples directly"). Walking moov →
    // trak → edts → elst manually keeps the assertion explicit.
    const moovStart = origInspect.ftypSize;
    const moovHdr = readBoxHeader(prelude, moovStart)!;
    const moovDataStart = moovStart + moovHdr.headerSize;
    const moovDataEnd = moovStart + moovHdr.size;
    let walked = moovDataStart;
    while (walked + 8 <= moovDataEnd) {
      const h = readBoxHeader(prelude, walked);
      if (!h || h.size <= 0) break;
      if (h.type === 'trak') {
        const trakEnd = walked + h.size;
        let q = walked + h.headerSize;
        while (q + 8 <= trakEnd) {
          const c = readBoxHeader(prelude, q);
          if (!c || c.size <= 0) break;
          if (c.type === 'edts') {
            const edtsEnd = q + c.size;
            let r = q + c.headerSize;
            while (r + 8 <= edtsEnd) {
              const e = readBoxHeader(prelude, r);
              if (!e || e.size <= 0) break;
              if (e.type === 'elst') {
                const elstPayload = r + e.headerSize;
                // entry_count must be zero — empty edit list.
                expect(prelude.readUInt32BE(elstPayload + 4)).toBe(0);
              }
              r += e.size;
            }
          }
          q += c.size;
        }
      }
      walked += h.size;
    }
  });
});

// ---------------------------------------------------------------------------
// frameRateFromIndex — unit tests for the DRY shared fps helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal IndexResult stub for frameRateFromIndex tests.
 * `fragments` is a list of sampleCount values; totalTrackDuration and
 * primaryTrackTimescale determine the total duration in seconds.
 */
function makeIndexResult(opts: {
  sampleCounts: number[];
  totalTrackDuration: number;
  primaryTrackTimescale: number;
}): IndexResult {
  return {
    ftypSize: 0,
    moov: {
      primaryTrackId: 1,
      primaryTrackTimescale: opts.primaryTrackTimescale,
      moovFileOffset: 0,
      moovSize: 0,
      mvhdTimescale: opts.primaryTrackTimescale,
      hasMehd: false,
      hasMvex: true,
      trackCount: 1,
      mvexOffsetInMoov: 0,
      mvexSize: 0,
      trexDefaults: new Map(),
      trackTimescales: new Map([[1, opts.primaryTrackTimescale]]),
    },
    fragments: opts.sampleCounts.map((sampleCount, i) => ({
      moofFileOffset: i * 1000,
      moofSize: 100,
      mdatSize: 100,
      decodeTime: 0,
      duration: 0,
      sampleCount,
    })),
    totalTrackDuration: opts.totalTrackDuration,
    mdatSpanStart: 0,
    mdatSpanEnd: 0,
  };
}

describe('frameRateFromIndex', () => {
  it('computes true average fps from real sample counts (VFR Reolink case)', (ctx) => {
    story(ctx, 'DRY helper: 430 próbek przez 30s ≈ 14.33 fps — to jest prawdziwa wartość dla Reolink VFR, nie wartość nominalna ×10 z trex.default_sample_duration (~150). Obie ścieżki (build + backfill) dostają identyczny wynik.');
    // 430 samples over 30 s in a 90000 timescale
    const index = makeIndexResult({
      sampleCounts: [200, 130, 100],
      totalTrackDuration: 30 * 90000,
      primaryTrackTimescale: 90000,
    });
    const fps = frameRateFromIndex(index);
    expect(fps).toBeCloseTo(430 / 30, 5);
  });

  it('sums sampleCount across all fragments', (ctx) => {
    story(ctx, 'Sumowanie po fragmentach: 3 fragmenty × 3 próbki = 9 total, podzielone przez czas = 30fps (jak w synthesized-mp4 teście buildSidecarForFile).');
    // matches the synthesized test above: 9 samples / 0.3 s = 30 fps
    const index = makeIndexResult({
      sampleCounts: [3, 3, 3],
      totalTrackDuration: 27000,
      primaryTrackTimescale: 90000,
    });
    const fps = frameRateFromIndex(index);
    expect(fps).toBeCloseTo(30, 5);
  });

  it('returns null when primaryTrackTimescale is zero', (ctx) => {
    story(ctx, 'Timescale=0 → null (uniknięcie dzielenia przez zero).');
    const index = makeIndexResult({
      sampleCounts: [430],
      totalTrackDuration: 2700000,
      primaryTrackTimescale: 0,
    });
    expect(frameRateFromIndex(index)).toBeNull();
  });

  it('returns null when there are no fragments (zero samples)', (ctx) => {
    story(ctx, 'Brak fragmentów = brak próbek = null (nie można wyliczyć fps).');
    const index = makeIndexResult({
      sampleCounts: [],
      totalTrackDuration: 90000,
      primaryTrackTimescale: 90000,
    });
    expect(frameRateFromIndex(index)).toBeNull();
  });

  it('returns null when fps would exceed the artefact cap (240)', (ctx) => {
    story(ctx, 'Wynik > 240 fps traktowany jako artefakt parsera → null (spójne z frameRateFromSampleCounts).');
    // 3000 samples / 1 s = 3000 fps → capped to null
    const index = makeIndexResult({
      sampleCounts: [3000],
      totalTrackDuration: 90000,
      primaryTrackTimescale: 90000,
    });
    expect(frameRateFromIndex(index)).toBeNull();
  });
});
