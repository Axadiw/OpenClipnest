// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { precacheShell, navigateWithShellFallback, type ShellDeps } from './shell';

/** A CacheStorage stand-in holding one cache, keyed by path. */
function fakeCaches() {
  const store = new Map<string, Response>();
  const cache = {
    add: vi.fn(async (url: string) => {
      const res = await deps.fetchImpl(url);
      if (!res.ok) throw new TypeError(`bad status ${res.status}`);
      store.set(url, res);
    }),
    put: vi.fn(async (url: string, res: Response) => { store.set(url, res); }),
    match: vi.fn(async (url: string) => store.get(url)?.clone()),
  };
  const deps: ShellDeps = {
    open: async () => cache as unknown as Cache,
    fetchImpl: vi.fn(async () => new Response('x')) as unknown as typeof fetch,
  };
  return { store, cache, deps };
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('precacheShell', () => {
  it('caches every URL that loads even when one of them fails', async () => {
    const { store, deps } = fakeCaches();
    deps.fetchImpl = vi.fn(async (u: RequestInfo | URL) => (String(u) === '/icon-512.png' ? new Response('', { status: 404 }) : new Response('ok'))) as unknown as typeof fetch;
    await expect(precacheShell(['/', '/icon-512.png', '/logo.svg'], deps)).resolves.toBeUndefined();
    expect([...store.keys()].sort()).toEqual(['/', '/logo.svg']);
  });
});

describe('navigateWithShellFallback', () => {
  const request = new Request('http://localhost/grid');

  it('uses the navigation preload response when there is one', async () => {
    const { deps } = fakeCaches();
    const res = await navigateWithShellFallback(request, Promise.resolve(html('preloaded')), deps, () => {});
    expect(await res.text()).toBe('preloaded');
    expect(deps.fetchImpl).not.toHaveBeenCalledWith(request);
  });

  it('fetches the page itself without a preload response', async () => {
    const { deps } = fakeCaches();
    deps.fetchImpl = vi.fn(async () => html('fresh')) as unknown as typeof fetch;
    const res = await navigateWithShellFallback(request, Promise.resolve(undefined), deps, () => {});
    expect(await res.text()).toBe('fresh');
  });

  it('refreshes the cached shell after a successful navigation, once per worker', async () => {
    const { store, deps } = fakeCaches();
    deps.fetchImpl = vi.fn(async () => html('new shell')) as unknown as typeof fetch;
    const pending: Promise<unknown>[] = [];
    const state = { refreshed: false };
    await navigateWithShellFallback(request, Promise.resolve(html('page')), deps, (p) => pending.push(p), state);
    await Promise.all(pending);
    expect(await store.get('/')?.clone().text()).toBe('new shell');
    await navigateWithShellFallback(request, Promise.resolve(html('page')), deps, (p) => pending.push(p), state);
    expect(pending).toHaveLength(1);
  });

  it('does not touch the shell after a failed navigation (error status)', async () => {
    const { store, deps } = fakeCaches();
    store.set('/', html('old shell'));
    const pending: Promise<unknown>[] = [];
    const res = await navigateWithShellFallback(request, Promise.resolve(html('down', 502)), deps, (p) => pending.push(p), { refreshed: false });
    expect(res.status).toBe(502);
    expect(pending).toHaveLength(0);
    expect(await store.get('/')?.clone().text()).toBe('old shell');
  });

  it('serves the cached shell when offline, and a placeholder without one', async () => {
    const { store, deps } = fakeCaches();
    deps.fetchImpl = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    const placeholder = await navigateWithShellFallback(request, Promise.resolve(undefined), deps, () => {});
    expect(await placeholder.text()).toContain('offline');
    store.set('/', html('cached shell'));
    const shell = await navigateWithShellFallback(request, Promise.reject(new TypeError('offline')), deps, () => {});
    expect(await shell.text()).toBe('cached shell');
  });
});
