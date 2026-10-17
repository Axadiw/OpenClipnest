import { describe, it, expect } from 'vitest';
import { computeBufferOverlay } from './bufferOverlayMath';
import { story } from '../test-story';

describe('computeBufferOverlay', () => {
  it('returns pct=0 with no MB display when duration is unknown', (ctx) => {
    story(ctx, 'Tuż po podpięciu <video> nie znamy jeszcze duration — nie ma jak policzyć "ile do startu", więc overlay pokazuje tylko spinner bez liczb. Liczby pojawią się gdy duration wskoczy z metadata.');
    const overlay = computeBufferOverlay({
      bufferedSec: 0,
      durationSec: null,
      directTotalBytes: 7_200_000,
      hlsLoadedBytes: null,
    });
    expect(overlay).toEqual({ pct: 0, downloadedBytes: null, startupBytes: null });
  });

  it('returns time-fraction pct with no MB when direct mp4 totalBytes unknown', (ctx) => {
    story(ctx, 'Legacy fallback bez media-token totalBytes (np. event sprzed v0.10.207) — overlay traci licznik MB, ale procent zbuforowanego czasu ma sens i prowadzi usera przez load.');
    const overlay = computeBufferOverlay({
      bufferedSec: 3,
      durationSec: 13.018,
      directTotalBytes: null,
      hlsLoadedBytes: null,
    });
    expect(overlay.pct).toBe(23);
    expect(overlay.downloadedBytes).toBeNull();
    expect(overlay.startupBytes).toBeNull();
  });

  it('uses summed buffered time as numerator for direct mp4 with totalBytes', (ctx) => {
    story(ctx, 'Klasyczna ścieżka direct-mp4 (Safari fallback albo browser bez MSE) — sekundy zbuforowane przekładają się proporcjonalnie na bajty. Identycznie jak przed v0.10.224, ale teraz dostajemy SUMĘ ranges, nie tylko end(last).');
    const overlay = computeBufferOverlay({
      bufferedSec: 6.509,
      durationSec: 13.018,
      directTotalBytes: 7_200_000,
      hlsLoadedBytes: null,
    });
    // 6.509/13.018 = 50% → 3.6 MB downloaded
    expect(overlay.downloadedBytes).toBe(3_600_000);
    // startupBytes = max(64KB, totalBytes * 3 / dur) = 7.2MB * 3 / 13.018 ≈ 1.66 MB
    expect(overlay.startupBytes).toBe(1_659_241);
    // pct = min(100, 3.6MB / 1.66MB * 100) → clamped to 100
    expect(overlay.pct).toBe(100);
  });

  it('uses actual HLS fragment bytes as numerator when hls is active', (ctx) => {
    story(ctx, 'Główny fix: w trybie HLS licznik nie kłamie. User wszedł z ?t=13 na 13.018 s klipie → hls.js pobrało init + segment 0 + segment 7 ≈ 1.68 MB; overlay pokazywał wcześniej "100% · 7.2 MB / 1.7 MB" (procent z czasu × direct-mp4 totalBytes). Teraz uczciwie liczy z FRAG_LOADED payloadów.');
    const overlay = computeBufferOverlay({
      bufferedSec: 2.365, // segment 0 (0.158 s) + segment 7 (2.207 s)
      durationSec: 13.018,
      directTotalBytes: 7_200_000,
      hlsLoadedBytes: 1_677_000, // init 1 KB + seg 0 689 KB + seg 7 987 KB
    });
    expect(overlay.downloadedBytes).toBe(1_677_000);
    // bytesPerSec = 1.677 MB / 2.365 s ≈ 0.709 MB/s; startupBytes ≈ 3 × 0.709 = 2.13 MB
    expect(overlay.startupBytes).toBe(2_127_273);
    // pct = min(100, 1.677 / 2.127 * 100) = 79
    expect(overlay.pct).toBe(79);
  });

  it('shows loaded HLS bytes alone before any buffered time is reported', (ctx) => {
    story(ctx, 'FRAG_LOADED odpala zanim MSE flushnie do v.buffered (mała wyścig kilka ms). Pokazujemy bytes downloaded żeby user miał jakikolwiek sygnał, ale bez startupBytes (nie mamy bitrate proxy bez zbuforowanych sekund).');
    const overlay = computeBufferOverlay({
      bufferedSec: 0,
      durationSec: 13.018,
      directTotalBytes: 7_200_000,
      hlsLoadedBytes: 689_000,
    });
    expect(overlay.pct).toBe(0);
    expect(overlay.downloadedBytes).toBe(689_000);
    expect(overlay.startupBytes).toBeNull();
  });

  it('clamps pct to 100 when fully buffered', (ctx) => {
    story(ctx, 'Cały klip w buforze — overlay i tak pokazuje 100% bez przekraczania, żeby nie raziło "147%" gdy startupBytes (próg do startu) jest dużo mniejszy niż całość filmu.');
    const overlay = computeBufferOverlay({
      bufferedSec: 13.018,
      durationSec: 13.018,
      directTotalBytes: 7_200_000,
      hlsLoadedBytes: 7_200_000,
    });
    expect(overlay.pct).toBe(100);
  });

  it('reports honest progress for disjoint HLS buffered ranges', (ctx) => {
    story(ctx, 'Bug z HAR-a: tylko start + ostatni segment w buforze. Stara formuła "end(last) / duration" dawała 100% bo end(last) sięgał końca filmu, mimo że środek był pusty. Suma ranges + rzeczywiste bytes z HLS = uczciwie ~18% czasu i adekwatny licznik MB.');
    const overlay = computeBufferOverlay({
      bufferedSec: 2.365,
      durationSec: 13.018,
      directTotalBytes: 7_200_000,
      hlsLoadedBytes: 1_677_000,
    });
    // Sanity: not 100% — broken HLS-edge case must report partial progress.
    expect(overlay.pct).toBeLessThan(100);
    expect(overlay.pct).toBeGreaterThan(0);
  });
});
