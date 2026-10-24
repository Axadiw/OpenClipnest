// @vitest-environment node
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSampleIndex, probeLayout, windowBytes } from '../mp4/sampleTable';

vi.mock('../scrubCache/client', () => ({ prefetchRange: vi.fn(async () => true) }));
import { prefetchRange } from '../scrubCache/client';
import { clearSampleIndexMemo, loadSampleIndex, prefetchWindow, sampleIndexTotal } from './sampleIndexLoader';

const load = (n: string) => new Uint8Array(readFileSync(new URL(`../mp4/__fixtures__/${n}`, import.meta.url)));
const fast = load('faststart-3s.mp4');
const frag = load('fragmented-3s.mp4');
const atEnd = load('moov-at-end-3s.mp4');
const URL_A = '/api/v0/events/abc/video/00?fmt=clean&token=t1';

/** Serves `file` by Range; `cap` truncates each 206 like the service worker's size cap. */
function fakeFetch(file: Uint8Array, cap = Infinity) {
  return vi.fn(async (_u: unknown, init?: RequestInit) => {
    const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range)!;
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]) + 1, file.length, start + cap);
    const slice = file.slice(start, end);
    return new Response(slice, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.length}` } });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('loadSampleIndex', () => {
  beforeEach(() => { clearSampleIndexMemo(); vi.mocked(prefetchRange).mockClear(); });

  it('indexes a faststart file with at most 2 fetches', async () => {
    const f = fakeFetch(fast);
    const ix = await loadSampleIndex(URL_A, new AbortController().signal, f);
    expect(ix).not.toBeNull();
    expect(f.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.mock.calls[0][1].headers.Range).toBe('bytes=0-65535');
  });

  it('records the size of the file the index was read from', async () => {
    expect(sampleIndexTotal(URL_A)).toBe(0);
    await loadSampleIndex(URL_A, new AbortController().signal, fakeFetch(fast));
    expect(sampleIndexTotal(URL_A.replace('t1', 't2'))).toBe(fast.length);
  });

  it('returns null for fragmented and moov-at-end files', async () => {
    expect(await loadSampleIndex(URL_A, new AbortController().signal, fakeFetch(frag))).toBeNull();
    expect(await loadSampleIndex('/api/v0/events/x/video/00?fmt=clean', new AbortController().signal, fakeFetch(atEnd))).toBeNull();
  });

  it('does not refetch for the same key with a different token', async () => {
    const f = fakeFetch(fast);
    await loadSampleIndex(URL_A, new AbortController().signal, f);
    const n = f.mock.calls.length;
    const again = await loadSampleIndex(URL_A.replace('t1', 't2'), new AbortController().signal, f);
    expect(again).not.toBeNull();
    expect(f.mock.calls.length).toBe(n);
  });

  it('does not memoise failures', async () => {
    const bad = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await loadSampleIndex(URL_A, new AbortController().signal, bad)).toBeNull();
    expect(await loadSampleIndex(URL_A, new AbortController().signal, fakeFetch(fast))).not.toBeNull();
  });

  it('completes when the worker answers with short 206s', async () => {
    const layout = probeLayout(fast);
    if (layout.kind !== 'faststart') throw new Error('fixture');
    const f = fakeFetch(fast, 700);
    const ix = await loadSampleIndex(URL_A, new AbortController().signal, f);
    expect(ix).not.toBeNull();
    expect(f.mock.calls.length).toBeGreaterThan(2);
    const ref = parseSampleIndex(fast.subarray(layout.moovStart, layout.moovEnd), layout.moovStart)!;
    expect(windowBytes(ix!, 1, 5)).toEqual(windowBytes(ref, 1, 5));
  });

  it('accepts a 200 full body', async () => {
    const f = vi.fn(async () => new Response(fast, { status: 200 })) as unknown as typeof fetch;
    expect(await loadSampleIndex(URL_A, new AbortController().signal, f)).not.toBeNull();
  });

  it('returns null when aborted', async () => {
    const c = new AbortController();
    c.abort();
    expect(await loadSampleIndex(URL_A, c.signal, fakeFetch(fast))).toBeNull();
  });
});

describe('prefetchWindow', () => {
  const layout = probeLayout(fast);
  if (layout.kind !== 'faststart') throw new Error('fixture');
  const ix = parseSampleIndex(fast.subarray(layout.moovStart, layout.moovEnd), layout.moovStart)!;

  it('skips cached bytes', async () => {
    vi.mocked(prefetchRange).mockClear();
    await prefetchWindow(URL_A, ix, 1, [windowBytes(ix, 1, 5)], new AbortController().signal);
    expect(prefetchRange).not.toHaveBeenCalled();
  });

  it('prefetches the gaps in order', async () => {
    vi.mocked(prefetchRange).mockClear();
    const w = windowBytes(ix, 1, 5);
    await prefetchWindow(URL_A, ix, 1, [], new AbortController().signal);
    expect(vi.mocked(prefetchRange).mock.calls.map((c) => c[1])).toEqual([w]);
  });
});
