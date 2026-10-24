/**
 * App-shell caching for the service worker: the precache on install and the network-first
 * navigation handler with an offline fallback. Pure apart from what `ShellDeps` provides, so it
 * runs under the unit tests.
 */

export interface ShellDeps {
  /** Opens the shell cache (`caches.open(SHELL_CACHE)` in the worker). */
  open(): Promise<Cache>;
  fetchImpl: typeof fetch;
}

/** The shell entry served for any navigation while offline. */
const SHELL_KEY = '/';

/**
 * Caches each URL on its own: one that fails (an icon a self-hosting proxy does not serve)
 * must not stop the worker from installing, which an atomic `addAll` would.
 */
export async function precacheShell(urls: readonly string[], deps: ShellDeps): Promise<void> {
  const cache = await deps.open();
  await Promise.all(urls.map((u) => cache.add(u).catch(() => { /* best effort */ })));
}

const OFFLINE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Clipnest — offline</title>'
  + '<body style="background:#06070C;color:#E6E9F0;font-family:system-ui;text-align:center;padding:40vh 16px;">'
  + '<h1>You\'re offline</h1><p>Clipnest needs a network connection to load. Try again in a moment.</p>';

/**
 * Network-first page load. Uses the navigation preload response when the browser made one
 * (`preload` resolves `undefined` otherwise), and after a successful load refreshes the cached
 * `/` shell once per worker start, so the offline fallback never points at hashed bundles a
 * release has removed. Offline, it serves that shell (the SPA router then picks up the URL),
 * or a minimal placeholder when the shell never made it into the cache.
 */
export async function navigateWithShellFallback(
  request: Request,
  preload: Promise<Response | undefined> | undefined,
  deps: ShellDeps,
  waitUntil: (p: Promise<unknown>) => void,
  state: { refreshed: boolean } = { refreshed: true },
): Promise<Response> {
  try {
    const preloaded = await preload;
    const fresh = preloaded ?? await deps.fetchImpl(request);
    if (fresh.ok && !state.refreshed) {
      state.refreshed = true;
      try {
        waitUntil(deps.open().then((c) => c.add(SHELL_KEY)).catch(() => { state.refreshed = false; }));
      } catch { /* the event is no longer extendable: refresh on a later navigation */
        state.refreshed = false;
      }
    }
    return fresh;
  } catch {
    const cache = await deps.open();
    const cached = await cache.match(SHELL_KEY);
    if (cached) return cached;
    return new Response(OFFLINE_PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}
