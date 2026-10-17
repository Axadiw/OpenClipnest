import { describe, it, expect } from 'vitest';
import { buildThrottleStream, decideThrottle } from './quota-throttle.js';
import { Readable } from 'node:stream';
import { story } from '../testing/story.js';

describe('decideThrottle', () => {
  it('passes through under 90% usage', (ctx) => {
    story(ctx, 'User w bezpiecznej strefie transferu (<90% limitu) ogląda nagrania z pełną prędkością — throttle wkracza dopiero, gdy realnie zbliża się do limitu planu.');
    expect(decideThrottle(50, 100)).toEqual({ mode: 'pass' });
    expect(decideThrottle(89, 100)).toEqual({ mode: 'pass' });
  });

  it('throttles at 90% to 120%', (ctx) => {
    story(ctx, 'Przy zużyciu 90-120% transferu user dostaje mocno ograniczone pasmo (512 KB/s) — może dokończyć odtwarzanie, ale nie zjada dalej puli w szybkim tempie.');
    expect(decideThrottle(90, 100)).toEqual({ mode: 'throttle', bytesPerSec: 512 * 1024 });
    expect(decideThrottle(100, 100)).toEqual({ mode: 'throttle', bytesPerSec: 512 * 1024 });
    expect(decideThrottle(119, 100)).toEqual({ mode: 'throttle', bytesPerSec: 512 * 1024 });
  });

  it('hard-blocks at >= 120%', (ctx) => {
    story(ctx, 'Po przekroczeniu 120% limitu transferu stream jest blokowany całkowicie — chroni infrastrukturę przed jednym userem, który „chce jeszcze trochę”.');
    expect(decideThrottle(120, 100)).toEqual({ mode: 'block' });
    expect(decideThrottle(500, 100)).toEqual({ mode: 'block' });
  });

  it('passes through when limit is 0 (unlimited plan)', (ctx) => {
    story(ctx, 'Użytkownik z planem bez limitu transferu nie jest throttlowany, niezależnie od zużycia — obsługa tarify „unlimited” bez osobnej gałęzi kodu.');
    expect(decideThrottle(99999, 0)).toEqual({ mode: 'pass' });
  });

  it('passes through when limit is negative (defensive)', (ctx) => {
    story(ctx, 'Ujemny limit (efekt zepsutej konfiguracji) nie blokuje userów — throttle przepuszcza ruch zamiast krzywdzić klienta za błąd serwera.');
    expect(decideThrottle(50, -1)).toEqual({ mode: 'pass' });
  });
});

describe('buildThrottleStream', () => {
  it('passes through when bytesPerSec is null', async (ctx) => {
    story(ctx, 'Bez parametru throttlingu stream przechodzi 1:1 — ścieżka szybka dla userów w limicie, bez dodawania opóźnień w happy path.');
    const src = Readable.from([Buffer.alloc(1024 * 1024)]);
    const t = buildThrottleStream(null);
    const chunks: Buffer[] = [];
    for await (const c of src.pipe(t)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toHaveLength(1024 * 1024);
  });

  it('caps throughput when bytesPerSec is set', async (ctx) => {
    story(ctx, 'Ustawiony limit prędkości realnie opóźnia stream do wskazanej wartości — user zobaczy, że player ładuje wolniej, gdy przekroczył limit, zamiast dostać natychmiastowy błąd.');
    const ONE_MB = 1024 * 1024;
    // Generate the megabyte in 8 KB chunks so the throttle has work to do
    const chunkSize = 8 * 1024;
    const chunkCount = ONE_MB / chunkSize;
    async function* gen() {
      for (let i = 0; i < chunkCount; i++) yield Buffer.alloc(chunkSize);
    }
    const src = Readable.from(gen());
    const t = buildThrottleStream(512 * 1024); // 512 KB/s

    const start = Date.now();
    const chunks: Buffer[] = [];
    for await (const c of src.pipe(t)) chunks.push(c as Buffer);
    const elapsed = Date.now() - start;

    expect(Buffer.concat(chunks)).toHaveLength(ONE_MB);
    // 1 MB at 512 KB/s ≈ 2000 ms; allow generous CI-jitter window
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(4000);
  });
});
