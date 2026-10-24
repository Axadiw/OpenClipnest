import { describe, it, expect, vi, afterEach } from 'vitest';
import { wipeScrubCache, prefetchRange, isScrubCacheActive, dropRecording, subscribeCachedRanges, onScrubCacheWipe, refreshCachedRanges, registerScrubServiceWorker, scrubCacheMaxBytes } from './client';

const URL0 = '/api/v0/events/abc/video/00?media_token=T&fmt=clean';

type Listener = (e: MessageEvent) => void;

function installWorker(controller: { postMessage: (...a: any[]) => void } | null) {
  const byType = new Map<string, Set<Listener>>();
  const of = (t: string) => byType.get(t) ?? byType.set(t, new Set()).get(t)!;
  const sw = {
    controller,
    addEventListener: (t: string, l: Listener) => of(t).add(l),
    removeEventListener: (t: string, l: Listener) => of(t).delete(l),
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  return {
    emit: (data: unknown) => of('message').forEach((l) => l({ data } as MessageEvent)),
    controllerChange: () => of('controllerchange').forEach((l) => l(new Event('controllerchange') as MessageEvent)),
    get listeners() { return { size: [...byType.values()].reduce((n, s) => n + s.size, 0) }; },
    sw,
  };
}

/** Posts of `scrub:ranges?` among a postMessage mock's calls. */
const queries = (post: ReturnType<typeof vi.fn>) => post.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'scrub:ranges?').length;

afterEach(() => {
  Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
  vi.useRealTimers();
});

describe('scrub cache client', () => {
  it('wipeScrubCache resolves without a controller', async () => {
    installWorker(null);
    await expect(wipeScrubCache()).resolves.toBeUndefined();
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
    await expect(wipeScrubCache()).resolves.toBeUndefined();
    expect(isScrubCacheActive()).toBe(false);
  });

  it('wipeScrubCache gives up after 500 ms when the worker never answers', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    installWorker({ postMessage: post });
    const p = wipeScrubCache();
    expect(post).toHaveBeenCalledWith({ type: 'scrub:wipe' }, expect.any(Array));
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBeUndefined();
  });

  it('wipeScrubCache tells page-side listeners at once, worker or not', async () => {
    installWorker(null);
    const l = vi.fn();
    const off = onScrubCacheWipe(l);
    await wipeScrubCache();
    expect(l).toHaveBeenCalledTimes(1);
    off();
    await wipeScrubCache();
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('prefetchRange resolves false without a controller', async () => {
    installWorker(null);
    await expect(prefetchRange(URL0, { start: 0, end: 10 }, new AbortController().signal)).resolves.toBe(false);
  });

  it('prefetchRange resolves with the worker answer', async () => {
    const post = vi.fn((msg: unknown, ports: MessagePort[]) => { ports[0].postMessage({ ok: true }); });
    installWorker({ postMessage: post });
    expect(isScrubCacheActive()).toBe(true);
    await expect(prefetchRange(URL0, { start: 5, end: 10 }, new AbortController().signal)).resolves.toBe(true);
    expect(post.mock.calls[0][0]).toEqual({ type: 'scrub:prefetch', url: URL0, start: 5, end: 10 });
  });

  it('aborting the signal posts scrub:cancel', async () => {
    const post = vi.fn();
    installWorker({ postMessage: post });
    const ac = new AbortController();
    const p = prefetchRange(URL0, { start: 0, end: 10 }, ac.signal);
    ac.abort();
    await expect(p).resolves.toBe(false);
    expect(post).toHaveBeenCalledWith({ type: 'scrub:cancel' });
  });

  it('dropRecording posts the cache key', () => {
    const post = vi.fn();
    installWorker({ postMessage: post });
    dropRecording(URL0);
    dropRecording('/api/v0/events/abc/thumbnail');
    expect(post.mock.calls).toEqual([[{ type: 'scrub:drop', key: 'abc/00/clean' }]]);
  });

  it('subscribeCachedRanges delivers only its own key and unsubscribes', () => {
    const w = installWorker({ postMessage: vi.fn() });
    const cb = vi.fn();
    const off = subscribeCachedRanges(URL0, cb);
    w.emit({ type: 'scrub:ranges', key: 'other/00/clean', total: 5, ranges: [] });
    w.emit({ type: 'scrub:ranges', key: 'abc/00/clean', total: 9, ranges: [{ start: 0, end: 3 }] });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ total: 9, ranges: [{ start: 0, end: 3 }] });
    off();
    expect(w.listeners.size).toBe(0);
  });
});

describe('subscribeCachedRanges current state', () => {
  it('asks the worker for the current ranges and delivers the answer', () => {
    const post = vi.fn((_m: unknown, ports?: MessagePort[]) => { ports?.[0].postMessage({ total: 100, ranges: [{ start: 1, end: 5 }] }); });
    installWorker({ postMessage: post });
    const cb = vi.fn();
    const off = subscribeCachedRanges(URL0, cb);
    expect(post.mock.calls.map((c) => c[0])).toContainEqual({ type: 'scrub:ranges?', key: expect.any(String) });
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(cb).toHaveBeenCalledWith({ total: 100, ranges: [{ start: 1, end: 5 }] });
      off();
      resolve();
    }, 10));
  });

  it('still delivers change messages and never calls back without a controller', () => {
    const w = installWorker(null);
    const cb = vi.fn();
    const off = subscribeCachedRanges(URL0, cb);
    expect(cb).not.toHaveBeenCalled();
    off();
    expect(w.listeners.size).toBe(0);
  });

  it('ignores a snapshot that arrives after a newer change announcement', async () => {
    let port: MessagePort | undefined;
    const post = vi.fn((_m: unknown, ports?: MessagePort[]) => { port = ports?.[0]; });
    const w = installWorker({ postMessage: post });
    const cb = vi.fn();
    const off = subscribeCachedRanges(URL0, cb);
    w.emit({ type: 'scrub:ranges', key: 'abc/00/clean', total: 9, ranges: [{ start: 0, end: 5 }], seq: 7, epoch: 'A' });
    port!.postMessage({ total: 9, ranges: [{ start: 0, end: 2 }], seq: 6, epoch: 'A' }); // older, answered late
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ total: 9, ranges: [{ start: 0, end: 5 }] });
    off();
  });

  it('resets the ordering when the worker restarts (new epoch) and still drops stale ones within it', () => {
    const w = installWorker({ postMessage: vi.fn() });
    const cb = vi.fn();
    const off = subscribeCachedRanges(URL0, cb);
    const msg = (epoch: string, seq: number, end: number) =>
      w.emit({ type: 'scrub:ranges', key: 'abc/00/clean', total: 9, ranges: [{ start: 0, end }], seq, epoch });
    msg('A', 40, 5);
    msg('B', 1, 3); // restarted worker: counter starts over
    expect(cb).toHaveBeenLastCalledWith({ total: 9, ranges: [{ start: 0, end: 3 }] });
    msg('B', 0, 1); // stale within epoch B
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('subscribeCachedRanges stays current across worker restarts', () => {
  it('asks again when a new worker takes control of the page', () => {
    const post = vi.fn();
    const w = installWorker({ postMessage: post });
    const off = subscribeCachedRanges(URL0, vi.fn());
    expect(queries(post)).toBe(1);
    w.controllerChange();
    expect(queries(post)).toBe(2);
    off();
    w.controllerChange();
    expect(queries(post)).toBe(2);
    expect(w.listeners.size).toBe(0);
  });

  it('asks again every 10 s while subscribed, and stops after unsubscribe', () => {
    vi.useFakeTimers();
    const post = vi.fn();
    installWorker({ postMessage: post });
    const off = subscribeCachedRanges(URL0, vi.fn());
    expect(queries(post)).toBe(1);
    vi.advanceTimersByTime(9_999);
    expect(queries(post)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(queries(post)).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(queries(post)).toBe(3);
    off();
    vi.advanceTimersByTime(60_000);
    expect(queries(post)).toBe(3);
  });

  it('refreshCachedRanges asks again for every live subscription', () => {
    const post = vi.fn();
    installWorker({ postMessage: post });
    const off1 = subscribeCachedRanges(URL0, vi.fn());
    const off2 = subscribeCachedRanges('/api/v0/events/xyz/video/01?fmt=clean', vi.fn());
    expect(queries(post)).toBe(2);
    refreshCachedRanges();
    expect(queries(post)).toBe(4);
    off1();
    off2();
    refreshCachedRanges();
    expect(queries(post)).toBe(4);
  });

  it('an empty snapshot from a restarted worker (new epoch) clears the cached stretches', async () => {
    const ports: MessagePort[] = [];
    const post = vi.fn((_m: unknown, p?: MessagePort[]) => { if (p?.[0]) ports.push(p[0]); });
    const w = installWorker({ postMessage: post });
    const cb = vi.fn();
    const off = subscribeCachedRanges(URL0, cb);
    w.emit({ type: 'scrub:ranges', key: 'abc/00/clean', total: 9, ranges: [{ start: 0, end: 5 }], seq: 40, epoch: 'A' });
    // The worker was stopped and restarted: its answer to the next query is empty, counter at 0.
    refreshCachedRanges();
    ports.at(-1)!.postMessage({ total: 0, ranges: [], seq: 0, epoch: 'B' });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenLastCalledWith({ total: 0, ranges: [] });
    off();
  });
});

describe('scrub cache memory cap', () => {
  const MiB = 1024 * 1024;
  const configs = (post: ReturnType<typeof vi.fn>) => post.mock.calls.map((c) => c[0] as { type?: string; maxBytes?: number }).filter((m) => m.type === 'scrub:config');
  function pointer(coarse: boolean) {
    vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: coarse && q === '(pointer: coarse)', media: q })));
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks for 64 MiB on touch devices and 256 MiB otherwise', () => {
    pointer(true);
    expect(scrubCacheMaxBytes()).toBe(64 * MiB);
    pointer(false);
    expect(scrubCacheMaxBytes()).toBe(256 * MiB);
  });

  it('sends the cap after registration and whenever another worker takes control', async () => {
    pointer(true);
    const post = vi.fn();
    const w = installWorker({ postMessage: post });
    Object.assign(w.sw, { register: vi.fn(async () => ({})) });
    registerScrubServiceWorker();
    await new Promise((r) => setTimeout(r, 0));
    expect(configs(post)).toEqual([{ type: 'scrub:config', maxBytes: 64 * MiB }]);
    w.controllerChange();
    expect(configs(post)).toHaveLength(2);
  });

  it('repeats the cap with every ranges query, so a restarted worker learns it again', () => {
    pointer(true);
    const post = vi.fn();
    installWorker({ postMessage: post });
    const off = subscribeCachedRanges(URL0, vi.fn());
    expect(configs(post)).toHaveLength(1);
    refreshCachedRanges();
    expect(configs(post)).toHaveLength(2);
    off();
  });
});
