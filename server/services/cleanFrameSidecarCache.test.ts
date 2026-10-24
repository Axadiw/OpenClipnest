import { describe, it, expect, vi } from 'vitest';
import { story } from '../testing/story.js';
import { createCleanFrameSidecarCache, estimateSidecarBytes } from './cleanFrameSidecarCache.js';
import type { CleanFrameSidecarData } from './mp4/cleanFrameSidecar.js';

/** A small but valid-looking sidecar; `tag` makes two of them distinguishable. */
function sidecar(tag: number, runs = 2): CleanFrameSidecarData {
  return {
    prelude: Buffer.from(`prelude-${tag}`),
    mdatHeader: Buffer.from([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]),
    byteRanges: Array.from({ length: runs }, (_, i) => ({ srcOffset: 100 + i * 1000, length: 100 })),
    frameGrid: [0, 0.04, 0.08],
  };
}

/** A manual clock, so TTL tests do not depend on real time. It must not start at 0: lru-cache reads a start time of 0 as "no
 *  timestamp" and would never expire the entry, whereas the real performance.now() is always positive. */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const BIG = { maxBytes: 64 * 1024 * 1024, maxEntries: 1000 };

describe('cleanFrameSidecarCache', () => {
  it('answers a repeat lookup from memory instead of loading again', async (ctx) => {
    story(ctx, 'Przeglądarka wysyła HEAD i kilka Range GET-ów na jedno odtworzenie, a każdy dotąd ściągał ten sam sidecar z magazynu. Po pierwszym pobraniu kolejne żądania nie mogą już nic kosztować.');
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG });
    const load = vi.fn(async () => sidecar(1));
    const a = await cache.get('rec/a.mp4', load);
    const b = await cache.get('rec/a.mp4', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it('keeps recordings apart', async (ctx) => {
    story(ctx, 'Dwa różne nagrania nie mogą dostać wzajemnie swoich sidecarów — inaczej odtwarzacz dostałby cudzą recepturę i zszył zły plik.');
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG });
    const a = await cache.get('rec/a.mp4', async () => sidecar(1));
    const b = await cache.get('rec/b.mp4', async () => sidecar(2));
    expect(a.prelude.toString()).toBe('prelude-1');
    expect(b.prelude.toString()).toBe('prelude-2');
  });

  it('lets concurrent misses share ONE load', async (ctx) => {
    story(ctx, 'Dziesięciu widzów otwierających świeży klip w tej samej chwili ma kosztować jedno pobranie z magazynu, a nie dziesięć.');
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG });
    let release!: (v: CleanFrameSidecarData) => void;
    const load = vi.fn(() => new Promise<CleanFrameSidecarData>((r) => { release = r; }));
    const all = Array.from({ length: 5 }, () => cache.get('rec/a.mp4', load));
    release(sidecar(7));
    const results = await Promise.all(all);
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it('stops trusting an entry once the TTL has passed', async (ctx) => {
    story(ctx, 'Sidecar może zostać przebudowany (backfill z innego procesu), więc wpis nie żyje wiecznie: po TTL kolejne żądanie dostaje świeżą wersję.');
    const c = clock();
    const cache = createCleanFrameSidecarCache({ ttlMs: 1000, ...BIG, perf: c });
    const load = vi.fn(async () => sidecar(1));
    await cache.get('rec/a.mp4', load);
    c.advance(999);
    await cache.get('rec/a.mp4', load);
    expect(load).toHaveBeenCalledTimes(1); // still fresh
    c.advance(2);
    await cache.get('rec/a.mp4', load);
    expect(load).toHaveBeenCalledTimes(2); // expired
  });

  it('does not cache a failure, and tells every waiter about it', async (ctx) => {
    story(ctx, 'Chwilowy błąd magazynu nie może się „przykleić": następne żądanie ma spróbować od nowa. Zapamiętany błąd = film, który nie gra mimo że magazyn już wstał.');
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG });
    let fail!: (e: Error) => void;
    const first = vi.fn(() => new Promise<CleanFrameSidecarData>((_, rej) => { fail = rej; }));
    const waiters = [cache.get('rec/a.mp4', first), cache.get('rec/a.mp4', first)];
    const settled = Promise.allSettled(waiters);
    fail(new Error('S3 503'));
    expect((await settled).map((r) => r.status)).toEqual(['rejected', 'rejected']);

    const second = vi.fn(async () => sidecar(2));
    await cache.get('rec/a.mp4', second);
    expect(second).toHaveBeenCalledTimes(1);
    expect(cache.stats().entries).toBe(1);
  });

  it('invalidate() drops the entry, and a load already in flight does not store its result', async (ctx) => {
    story(ctx, 'Gdy trasa uzna sidecar za nieświeży i go unieważni, to wynik pobrania, które akurat leciało, nie może wrócić do cache i zablokować odświeżonej wersji.');
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG });
    await cache.get('rec/a.mp4', async () => sidecar(1));
    cache.invalidate('rec/a.mp4');
    expect(cache.stats().entries).toBe(0);

    let release!: (v: CleanFrameSidecarData) => void;
    const slow = vi.fn(() => new Promise<CleanFrameSidecarData>((r) => { release = r; }));
    const inFlight = cache.get('rec/b.mp4', slow);
    cache.invalidate('rec/b.mp4');
    release(sidecar(2));
    await inFlight; // the waiter still gets its value ...
    expect(cache.stats().entries).toBe(0); // ... but it was not stored
    const again = vi.fn(async () => sidecar(3));
    await cache.get('rec/b.mp4', again);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('with a TTL of 0 never stores anything but still shares concurrent loads', async (ctx) => {
    story(ctx, 'CLEAN_FRAME_CACHE_TTL_MS=0 to wyłącznik awaryjny: zachowanie jak sprzed cache\'u, ale równoległe żądania i tak nie mnożą pobrań.');
    const cache = createCleanFrameSidecarCache({ ttlMs: 0, ...BIG });
    const load = vi.fn(async () => sidecar(1));
    await cache.get('rec/a.mp4', load);
    await cache.get('rec/a.mp4', load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);

    let release!: (v: CleanFrameSidecarData) => void;
    const slow = vi.fn(() => new Promise<CleanFrameSidecarData>((r) => { release = r; }));
    const pair = [cache.get('rec/c.mp4', slow), cache.get('rec/c.mp4', slow)];
    release(sidecar(2));
    await Promise.all(pair);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entry when the memory budget is exceeded', async (ctx) => {
    story(ctx, 'Pamięć poda API jest ograniczona: cache ma limit w bajtach i wyrzuca najdawniej używane wpisy, zamiast rosnąć bez końca.');
    const one = estimateSidecarBytes(sidecar(0));
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, maxBytes: one * 2 + 1, maxEntries: 1000 });
    await cache.get('rec/a.mp4', async () => sidecar(1));
    await cache.get('rec/b.mp4', async () => sidecar(2));
    await cache.get('rec/a.mp4', async () => sidecar(1)); // touch a, so b is now the oldest
    await cache.get('rec/c.mp4', async () => sidecar(3));
    expect(cache.stats().entries).toBe(2);
    const reload = vi.fn(async () => sidecar(2));
    await cache.get('rec/b.mp4', reload);
    expect(reload).toHaveBeenCalledTimes(1); // b was evicted
  });

  it('reports every lookup as a hit or a miss', async (ctx) => {
    story(ctx, 'Licznik trafień i chybień jest jedynym sposobem, żeby po wdrożeniu zobaczyć, czy cache faktycznie pracuje.');
    const seen: string[] = [];
    const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG, onResult: (r) => seen.push(r) });
    await cache.get('rec/a.mp4', async () => sidecar(1));
    await cache.get('rec/a.mp4', async () => sidecar(1));
    await cache.get('rec/b.mp4', async () => sidecar(2));
    expect(seen).toEqual(['miss', 'hit', 'miss']);
  });

  describe('a recording that has no sidecar', () => {
    const gone = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const isGone = (e: unknown) => (e as Error).name === 'NoSuchKey';

    it('is reported as absent, not as a miss, and is looked up again every time', async (ctx) => {
      story(ctx, 'Nagranie bez sidecara (plik klasy B/C, albo klip, któremu sidecar jeszcze nie powstał) przy każdym żądaniu idzie do magazynu po plik, którego nie ma, bo „brak" nigdy nie jest cache\'owany. Gdyby ten przypadek liczył się jako miss, wskaźnik trafień spadałby z powodu klipów, których cache nie dotyczy, a nie z powodu cache\'u.');
      const seen: string[] = [];
      const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG, onResult: (r) => seen.push(r) });
      const missing = vi.fn(async (): Promise<CleanFrameSidecarData> => { throw gone(); });
      await expect(cache.get('rec/a.mp4', missing, isGone)).rejects.toThrow('NoSuchKey');
      await expect(cache.get('rec/a.mp4', missing, isGone)).rejects.toThrow('NoSuchKey');
      expect(missing).toHaveBeenCalledTimes(2); // not remembered
      expect(seen).toEqual(['absent', 'absent']);

      // The sidecar shows up later: the next lookup picks it up, and then it is cached like any other.
      await cache.get('rec/a.mp4', async () => sidecar(1), isGone);
      await cache.get('rec/a.mp4', async () => sidecar(1), isGone);
      expect(seen).toEqual(['absent', 'absent', 'miss', 'hit']);
      expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, absent: 2, entries: 1 });
    });

    it('counts any other failure as a miss: the object store was asked and did not answer', async (ctx) => {
      story(ctx, 'Chwilowy błąd magazynu to nie „brak sidecara": zapytanie poszło do magazynu, więc liczy się jako miss. „Absent" jest zarezerwowane dla stanu trwałego, żeby dało się go czytać jako „tyle klipów nie ma sidecara".');
      const seen: string[] = [];
      const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG, onResult: (r) => seen.push(r) });
      const flaky = async (): Promise<CleanFrameSidecarData> => { throw Object.assign(new Error('S3 503'), { name: 'ServiceUnavailable' }); };
      await expect(cache.get('rec/a.mp4', flaky, isGone)).rejects.toThrow('S3 503');
      expect(seen).toEqual(['miss']);
    });

    it('counts a failure as a miss when the caller cannot tell what kind it is', async (ctx) => {
      story(ctx, 'Wywołujący, który nie podał, jak rozpoznać „brak", dostaje stare zachowanie: każdy nieudany odczyt to miss. Cache sam nie zgaduje, co znaczy błąd magazynu.');
      const seen: string[] = [];
      const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG, onResult: (r) => seen.push(r) });
      await expect(cache.get('rec/a.mp4', async () => { throw gone(); })).rejects.toThrow('NoSuchKey');
      expect(seen).toEqual(['miss']);
    });

    it('reports a lookup once, however many requests wait on the same load', async (ctx) => {
      story(ctx, 'Dziesięć żądań czekających na to samo pobranie to jedno zapytanie do magazynu. Liczone raz, bo licznik ma mówić, ile razy cache musiał pytać, a nie ilu było widzów.');
      const seen: string[] = [];
      const cache = createCleanFrameSidecarCache({ ttlMs: 60_000, ...BIG, onResult: (r) => seen.push(r) });
      let fail!: (e: Error) => void;
      const load = vi.fn(() => new Promise<CleanFrameSidecarData>((_, rej) => { fail = rej; }));
      const waiters = Array.from({ length: 4 }, () => cache.get('rec/a.mp4', load, isGone));
      const settled = Promise.allSettled(waiters);
      expect(seen).toEqual([]); // nothing is known until the load settles
      fail(gone());
      expect((await settled).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
      expect(load).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(['absent']);
    });
  });

  it('estimates a bigger sidecar as costing more memory', (ctx) => {
    story(ctx, 'Limit pamięci liczy się z rozmiaru wpisu: większy sidecar (więcej fragmentów i klatek) musi kosztować więcej niż mały.');
    const small = estimateSidecarBytes(sidecar(1, 2));
    const large = estimateSidecarBytes({ ...sidecar(1, 500), frameGrid: new Array(5000).fill(0) });
    expect(large).toBeGreaterThan(small * 10);
  });
});
