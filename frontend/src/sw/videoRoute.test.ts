// @vitest-environment node
// The worker's globals (Request/Response/streams) are the platform's, not the DOM shim's.
import { describe, it, expect, vi } from 'vitest';
import { RangeCache } from './rangeCache';
import { handleVideoRequest, prefetchIntoCache, respondVideo, throttlePerKey, RESPONSE_CAP } from './videoRoute';

const MiB = 1024 * 1024;
const URL0 = 'http://localhost/api/v0/events/abc/video/00?media_token=T&fmt=clean';
const KEY = 'abc/00/clean';

function content(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

type Call = { url: string; range: string | null; priority: string | undefined };

/** A fake upstream that answers Range requests over `body`, streaming 64 KiB chunks. */
function fakeUpstream(body: Uint8Array, opts: { status?: number } = {}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const range = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('Range');
    calls.push({ url, range, priority: (init as { priority?: string } | undefined)?.priority });
    if (opts.status && opts.status !== 206) {
      return new Response('nope', { status: opts.status });
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = Math.min(m && m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
    const slice = body.subarray(start, end + 1);
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= slice.length) { c.close(); return; }
        const n = Math.min(64 * 1024, slice.length - off);
        c.enqueue(slice.slice(off, off + n));
        off += n;
      },
    }, { highWaterMark: 0 });
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': String(slice.length),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls, spy: impl };
}

function req(range: string | null, url = URL0): Request {
  return new Request(url, { headers: range ? { Range: range } : {} });
}

/** Byte equality without vitest's element-by-element deep diff (slow on megabytes). */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function body(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe('handleVideoRequest', () => {
  it('second identical range is served without upstream', async () => {
    const data = content(1 * MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    const r1 = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(r1.status).toBe(206);
    expect(same(await body(r1), data)).toBe(true);
    const r2 = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(r2.status).toBe(206);
    expect(r2.headers.get('Content-Range')).toBe(`bytes 0-${MiB - 1}/${MiB}`);
    expect(r2.headers.get('Content-Length')).toBe(String(MiB));
    expect(r2.headers.get('Content-Type')).toBe('video/mp4');
    expect(r2.headers.get('Accept-Ranges')).toBe('bytes');
    expect(r2.headers.get('Cache-Control')).toBe('no-store');
    expect(same(await body(r2), data)).toBe(true);
    const r3 = await handleVideoRequest(req('bytes=100-199'), cache, up.impl);
    expect(r3.headers.get('Content-Range')).toBe(`bytes 100-199/${MiB}`);
    expect(same(await body(r3), data.subarray(100, 200))).toBe(true);
    expect(up.spy).toHaveBeenCalledTimes(1);
  });

  it('a new media token reuses the bytes cached under the old one', async () => {
    const data = content(MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    await body(await handleVideoRequest(req('bytes=0-'), cache, up.impl));
    const r = await handleVideoRequest(req('bytes=0-1', URL0.replace('T&', 'T2&') + '&retry=1'), cache, up.impl);
    expect(same(await body(r), data.subarray(0, 2))).toBe(true);
    expect(up.spy).toHaveBeenCalledTimes(1);
  });

  it('non-206 upstream is passed through and not cached', async () => {
    const up = fakeUpstream(content(MiB), { status: 401 });
    const cache = new RangeCache();
    const r = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('nope');
    expect(cache.ranges(KEY)).toEqual([]);
  });

  it('aborted stream keeps received pieces', async () => {
    const data = content(MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    const r = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    const reader = r.body!.getReader();
    let got = 0;
    while (got < 262144) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
    }
    await reader.cancel();
    const kept = cache.contiguousFrom(KEY, 0, MiB);
    expect(kept).toBeGreaterThanOrEqual(262144);
    expect(kept).toBeLessThan(MiB);
    // The cached prefix is answered from memory...
    const again = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(again.headers.get('Content-Range')).toBe(`bytes 0-${kept - 1}/${MiB}`);
    expect(same(await body(again), data.subarray(0, kept))).toBe(true);
    expect(up.calls).toHaveLength(1);
    // ...and the browser's follow-up for the rest goes upstream from the first missing byte.
    const rest = await handleVideoRequest(req(`bytes=${kept}-`), cache, up.impl);
    expect(up.calls[1].range).toBe(`bytes=${kept}-${MiB - 1}`);
    expect(same(await body(rest), data.subarray(kept))).toBe(true);
    expect(cache.ranges(KEY)).toEqual([{ start: 0, end: MiB }]);
  });

  it('open-ended request is capped at 4 MiB', async () => {
    const data = content(10 * MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    const r = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(up.calls[0].range).toBe(`bytes=0-${RESPONSE_CAP - 1}`);
    expect(RESPONSE_CAP).toBe(4 * MiB);
    expect(r.headers.get('Content-Range')).toBe(`bytes 0-${4 * MiB - 1}/${10 * MiB}`);
    expect((await body(r)).length).toBe(4 * MiB);
    // From memory the cap holds too.
    const again = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(again.headers.get('Content-Range')).toBe(`bytes 0-${4 * MiB - 1}/${10 * MiB}`);
    expect(up.calls).toHaveLength(1);
  });

  it('explicit whole-file range is capped at 4 MiB', async () => {
    const size = 10 * MiB;
    const data = content(size);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    // Safari: a 2-byte probe, then the whole file in one explicit range.
    const probe = await handleVideoRequest(req('bytes=0-1'), cache, up.impl);
    expect(probe.headers.get('Content-Range')).toBe(`bytes 0-1/${size}`);
    expect(same(await body(probe), data.subarray(0, 2))).toBe(true);
    // The whole-file request is NOT answered with the 2 cached probe bytes: it goes upstream,
    // capped at 4 MiB.
    const r = await handleVideoRequest(req(`bytes=0-${size - 1}`), cache, up.impl);
    expect(up.calls[1].range).toBe(`bytes=0-${4 * MiB - 1}`);
    expect(r.headers.get('Content-Range')).toBe(`bytes 0-${4 * MiB - 1}/${size}`);
    expect(same(await body(r), data.subarray(0, 4 * MiB))).toBe(true);
    // The next explicit range is capped too.
    const r2 = await handleVideoRequest(req(`bytes=${4 * MiB}-${size - 1}`), cache, up.impl);
    expect(up.calls[2].range).toBe(`bytes=${4 * MiB}-${8 * MiB - 1}`);
    expect(r2.headers.get('Content-Range')).toBe(`bytes ${4 * MiB}-${8 * MiB - 1}/${size}`);
    expect((await body(r2)).length).toBe(4 * MiB);
    expect(cache.ranges(KEY)).toEqual([{ start: 0, end: 8 * MiB }]);
  });

  it('an upstream fetch stops before the next cached piece', async () => {
    const data = content(MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    await body(await handleVideoRequest(req('bytes=500000-599999'), cache, up.impl));
    const r = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(up.calls[1].range).toBe('bytes=0-499999');
    expect((await body(r)).length).toBe(500000);
  });

  it('a cached prefix shorter than one piece is not served alone', async () => {
    const data = content(MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    await body(await handleVideoRequest(req('bytes=0-999'), cache, up.impl));
    // Fully covered: from memory.
    const small = await handleVideoRequest(req('bytes=10-99'), cache, up.impl);
    expect(small.headers.get('Content-Range')).toBe(`bytes 10-99/${MiB}`);
    expect(up.calls).toHaveLength(1);
    // Only 1000 bytes of the asked-for range are cached: upstream.
    const r = await handleVideoRequest(req('bytes=0-'), cache, up.impl);
    expect(up.calls[1].range).toBe(`bytes=0-${MiB - 1}`);
    expect(same(await body(r), data)).toBe(true);
  });

  it('in-flight stream across a total-mismatch reset does not write old bytes into the new entry', async () => {
    const cache = new RangeCache();
    const a = fakeUpstream(content(MiB));
    const rA = await handleVideoRequest(req('bytes=0-'), cache, a.impl);
    const readerA = rA.body!.getReader();
    await readerA.read(); // 64 KiB in flight, not yet flushed as a piece
    const b = fakeUpstream(content(2 * MiB));
    await body(await handleVideoRequest(req('bytes=0-99'), cache, b.impl)); // resets the entry
    for (;;) { const { done } = await readerA.read(); if (done) break; }
    expect(cache.meta(KEY)?.total).toBe(2 * MiB);
    expect(cache.ranges(KEY)).toEqual([]);
    expect(cache.size()).toBe(0);
  });

  for (const how of ['wipe', 'drop'] as const) {
    it(`a request awaiting headers across ${how}() leaves the cache empty`, async () => {
      const cache = new RangeCache();
      const up = fakeUpstream(content(MiB));
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const slow = (async (i: RequestInfo | URL, init?: RequestInit) => { await gate; return up.impl(i, init); }) as typeof fetch;
      const pending = handleVideoRequest(req('bytes=0-'), cache, slow);
      await Promise.resolve();
      if (how === 'wipe') cache.wipe(); else cache.drop(KEY);
      release();
      const r = await pending;
      expect(r.status).toBe(206);
      expect((await body(r)).length).toBe(MiB);
      expect(cache.meta(KEY)).toBeUndefined();
      expect(cache.size()).toBe(0);
    });
  }

  it('preview request uses low priority', async () => {
    const up = fakeUpstream(content(MiB));
    const cache = new RangeCache();
    await body(await handleVideoRequest(req('bytes=0-99', `${URL0}&scrub=1`), cache, up.impl));
    await body(await handleVideoRequest(req('bytes=100-199'), cache, up.impl));
    expect(up.calls[0].priority).toBe('low');
    expect(up.calls[0].url).toBe(URL0);
    expect(up.calls[1].priority).toBe('high');
  });

  it('suffix and multi-range requests pass through untouched', async () => {
    const up = fakeUpstream(content(MiB));
    const cache = new RangeCache();
    const r = await handleVideoRequest(req('bytes=-500'), cache, up.impl);
    expect(up.calls[0].range).toBe('bytes=-500');
    await r.arrayBuffer();
    expect(cache.ranges(KEY)).toEqual([]);
  });

  it('a changed file size drops the old bytes and serves upstream as is', async () => {
    const cache = new RangeCache();
    const a = fakeUpstream(content(MiB));
    await body(await handleVideoRequest(req('bytes=0-99'), cache, a.impl));
    const b = fakeUpstream(content(2 * MiB));
    const r = await handleVideoRequest(req('bytes=200-299'), cache, b.impl);
    expect(r.headers.get('Content-Range')).toBe(`bytes 200-299/${2 * MiB}`);
    await body(r);
    expect(cache.ranges(KEY)).toEqual([]);
    expect(cache.meta(KEY)?.total).toBe(2 * MiB);
  });
});

describe('prefetchIntoCache', () => {
  it('gives up when upstream answers a range that does not move forward', async () => {
    const data = content(10_000);
    let calls = 0;
    // A broken upstream that always answers bytes 0-99, whatever is asked.
    const impl = vi.fn(async () => {
      calls++;
      if (calls > 20) throw new Error('looping');
      return new Response(data.slice(0, 100) as Uint8Array<ArrayBuffer>, {
        status: 206,
        headers: { 'Content-Range': `bytes 0-99/${data.length}`, 'Content-Type': 'video/mp4' },
      });
    }) as unknown as typeof fetch;
    const cache = new RangeCache();
    const ok = await prefetchIntoCache(URL0, 500, 2000, cache, impl, new AbortController().signal);
    expect(ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('fills the range at low priority, skipping bytes already cached', async () => {
    const data = content(6 * MiB);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    await body(await handleVideoRequest(req('bytes=0-99'), cache, up.impl));
    const ok = await prefetchIntoCache(URL0, 0, 5 * MiB, cache, up.impl, new AbortController().signal);
    expect(ok).toBe(true);
    expect(cache.ranges(KEY)).toEqual([{ start: 0, end: 5 * MiB }]);
    expect(up.calls.slice(1).map((c) => [c.range, c.priority, c.url])).toEqual([
      [`bytes=100-${100 + 4 * MiB - 1}`, 'low', URL0],
      [`bytes=${100 + 4 * MiB}-${5 * MiB - 1}`, 'low', URL0],
    ]);
    // Already cached: no upstream at all; past the end of the file is clamped.
    expect(await prefetchIntoCache(URL0, 0, 100 * MiB, cache, fakeUpstream(data).impl, new AbortController().signal)).toBe(true);
  });

  it('drop stops a running prefetch of that recording', async () => {
    const cache = new RangeCache();
    const up = fakeUpstream(content(6 * MiB));
    let n = 0;
    const dropping = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const res = await up.impl(i, init);
      if (++n === 1) cache.drop(KEY); // the player closes while the first slice is on its way
      return res;
    }) as typeof fetch;
    const ok = await prefetchIntoCache(URL0, 0, 5 * MiB, cache, dropping, new AbortController().signal);
    expect(ok).toBe(false);
    expect(n).toBe(1);
    expect(cache.ranges(KEY)).toEqual([]);
    expect(cache.size()).toBe(0);
  });

  it('resolves false when aborted or on a non-206', async () => {
    const cache = new RangeCache();
    const ac = new AbortController();
    ac.abort();
    expect(await prefetchIntoCache(URL0, 0, 10, cache, fakeUpstream(content(MiB)).impl, ac.signal)).toBe(false);
    expect(await prefetchIntoCache(URL0, 0, 10, cache, fakeUpstream(content(MiB), { status: 403 }).impl, new AbortController().signal)).toBe(false);
  });
});

describe('respondVideo', () => {
  it('falls back to a plain network fetch of the original request when the worker path throws', async () => {
    const data = content(1000);
    const up = fakeUpstream(data);
    const cache = new RangeCache();
    // The cache misbehaves (a worker bug): the request must still reach the network.
    cache.meta = () => { throw new Error('boom'); };
    const original = req('bytes=0-99');
    const res = await respondVideo(original, cache, up.impl);
    expect(res.status).toBe(206);
    expect(same(await body(res), data.subarray(0, 100))).toBe(true);
    expect(up.spy).toHaveBeenCalledTimes(1);
    expect(up.spy.mock.calls[0][0]).toBe(original);
  });

  it('falls back when the upstream fetch inside the worker path rejects', async () => {
    let n = 0;
    const impl = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError('network');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await respondVideo(req('bytes=0-99'), new RangeCache(), impl);
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it('behaves like handleVideoRequest when nothing fails', async () => {
    const up = fakeUpstream(content(1000));
    const res = await respondVideo(req('bytes=0-'), new RangeCache(), up.impl);
    expect(res.status).toBe(206);
    expect(up.spy).toHaveBeenCalledTimes(1);
  });
});

describe('throttlePerKey', () => {
  it('fires at most once per interval per key, always delivering the last call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = throttlePerKey(fn, 250);
    t('a'); t('a'); t('a'); t('b');
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
    vi.advanceTimersByTime(250);
    expect(fn.mock.calls).toEqual([['a'], ['b'], ['a']]);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    t('a');
    expect(fn).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
