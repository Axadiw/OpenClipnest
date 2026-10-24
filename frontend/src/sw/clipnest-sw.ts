/* Clipnest service worker.
 *
 * Bundled by `vite-plugin-sw.ts` into a classic script served at `/clipnest-sw.js`.
 *
 * Two jobs:
 * 1. Caches the SPA app shell (index.html + static assets) so that a phone with
 *    no signal can still open Clipnest and see the landing/login surface.
 * 2. Answers Range requests for clean video (`/api/v0/events/:id/video/:view?fmt=clean`)
 *    from an IN-MEMORY byte-range cache shared by the main player and the scrub
 *    preview, fetching misses upstream. Nothing video-related is persisted: a worker
 *    restart just loses the cache. Every other request passes through untouched.
 */
import { RangeCache } from './rangeCache';
import { prefetchIntoCache, respondVideo, throttlePerKey } from './videoRoute';
import { videoCacheKey } from './videoRequest';
import { navigateWithShellFallback, precacheShell, type ShellDeps } from './shell';

// Minimal ServiceWorkerGlobalScope surface. The `webworker` lib cannot be mixed with the
// app's `dom` lib in one TypeScript project, so the few members used here are typed locally.
type ExtendableEventLike = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEventLike = ExtendableEventLike & {
  request: Request;
  preloadResponse?: Promise<Response | undefined>;
  respondWith(r: Promise<Response> | Response): void;
};
type MessageEventLike = ExtendableEventLike & {
  data: unknown;
  ports: readonly MessagePort[];
  source: { id?: string } | null;
};
type ClientLike = { postMessage(msg: unknown): void };
type SwScope = {
  location: Location;
  registration: { navigationPreload?: { enable(): Promise<void> } };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(o?: { type?: string }): Promise<readonly ClientLike[]> };
  addEventListener(type: 'install' | 'activate', l: (e: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', l: (e: FetchEventLike) => void): void;
  addEventListener(type: 'message', l: (e: MessageEventLike) => void): void;
};
const sw = self as unknown as SwScope;

// === PWA app-shell cache ===
// The SPA bootstrap (index.html + a handful of static assets) is the
// "shell" — a phone with no signal can still open Clipnest and see the
// landing/login surface as long as these are cached. Bump the version
// suffix every time we change SHELL_URLS or the SW logic so old shells
// get reaped on activate.
const SHELL_CACHE = 'clipnest-shell-v3';
// Stable, hashless URLs only. Hashed /assets/<bundle>.js entries change
// every release and will be re-fetched lazily; the browser HTTP cache
// (1y immutable on /assets/) covers them once they're loaded once.
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/logo.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/favicon-16.png',
];

// Names of caches this SW is allowed to keep around. Anything else found
// during activate gets reaped — that's how previous-build shell caches
// get evicted after a release.
const KNOWN_CACHES = new Set([SHELL_CACHE]);

const shellDeps: ShellDeps = { open: () => caches.open(SHELL_CACHE), fetchImpl: (i, init) => fetch(i, init) };
/** The `/` shell is refreshed after the first successful navigation of each worker start. */
const shellState = { refreshed: false };

sw.addEventListener('install', (event) => {
  // Take over from the previous SW build immediately; we don't have
  // long-lived background work that would benefit from waiting.
  void sw.skipWaiting();
  // Precache the app shell, best effort per URL: one asset a self-hosting proxy does not
  // serve must not keep the worker (and its video cache) from installing.
  event.waitUntil(precacheShell(SHELL_URLS, shellDeps));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Navigation preload: the browser starts a page's request while the worker boots, and
    // the navigate handler uses that response (`event.preloadResponse`).
    await sw.registration.navigationPreload?.enable().catch(() => { /* unsupported: fetch instead */ });
    // Reap any cache name that isn't part of the current build. Catches
    // previous-version shell caches (clipnest-shell-v0, …) and any
    // experimental ones left around.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => !KNOWN_CACHES.has(n))
        .map((n) => caches.delete(n)),
    );
    // Claim open clients so the *current* page session benefits from
    // the new SW without a reload — otherwise the user wouldn't see
    // caching until the next navigation.
    await sw.clients.claim();
  })());
});

// === In-memory video range cache ===
const videoCache = new RangeCache();
const upstreamFetch: typeof fetch = (input, init) => fetch(input, init);

// Pages draw cached ranges as grey segments; tell them at most 4 times a second per recording.
const announce = throttlePerKey((key) => {
  const msg = { type: 'scrub:ranges', key, ...videoCache.snapshot(key) };
  void sw.clients.matchAll({ type: 'window' }).then((all) => all.forEach((c) => c.postMessage(msg)));
}, 250);
videoCache.onChange = announce;

sw.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Top-level navigation (HTML page load). Network-first so the freshest
  // SPA shell wins, but fall back to the cached `/` shell when offline so
  // a phone with no signal still gets the app instead of the browser's
  // dino page. Cached SPA bundle then bootstraps the route client-side.
  if (event.request.mode === 'navigate') {
    event.respondWith(navigateWithShellFallback(
      event.request, event.preloadResponse, shellDeps, (p) => event.waitUntil(p), shellState,
    ));
    return;
  }

  if (videoCacheKey(event.request.url)) {
    event.respondWith(respondVideo(event.request, videoCache, upstreamFetch));
  }
});

// One running prefetch per page: a new one (or `scrub:cancel`) aborts the previous one.
const prefetches = new Map<string, { ac: AbortController; key: string | null }>();

type PageMessage =
  | { type: 'scrub:prefetch'; url: string; start: number; end: number }
  | { type: 'scrub:cancel' }
  | { type: 'scrub:drop'; key: string }
  | { type: 'scrub:wipe' }
  | { type: 'scrub:ranges?'; key: string }
  | { type: 'scrub:config'; maxBytes: number };

sw.addEventListener('message', (event) => {
  const msg = event.data as PageMessage | null;
  const client = event.source?.id ?? '';
  const reply = (data: unknown) => event.ports[0]?.postMessage(data);
  switch (msg?.type) {
    case 'scrub:prefetch': {
      prefetches.get(client)?.ac.abort();
      const ac = new AbortController();
      const url = new URL(msg.url, sw.location.href).href;
      const running = { ac, key: videoCacheKey(url) };
      prefetches.set(client, running);
      event.waitUntil(
        prefetchIntoCache(url, msg.start, msg.end, videoCache, upstreamFetch, ac.signal).then((ok) => {
          if (prefetches.get(client) === running) prefetches.delete(client);
          reply({ ok });
        }),
      );
      break;
    }
    case 'scrub:cancel':
      prefetches.get(client)?.ac.abort();
      prefetches.delete(client);
      break;
    case 'scrub:drop':
      // Stop every page's prefetch of this recording (it would refill it), then free it.
      for (const [id, p] of prefetches) {
        if (p.key === msg.key) {
          p.ac.abort();
          prefetches.delete(id);
        }
      }
      videoCache.drop(msg.key);
      break;
    case 'scrub:ranges?':
      reply(videoCache.snapshot(msg.key));
      break;
    case 'scrub:config':
      // Pages ask for a memory budget (64 MiB on touch devices, 256 MiB otherwise); the
      // smallest one asked for since this worker started wins, evicting down at once.
      if (typeof msg.maxBytes === 'number') videoCache.lowerCap(msg.maxBytes);
      break;
    case 'scrub:wipe':
      for (const p of prefetches.values()) p.ac.abort();
      prefetches.clear();
      videoCache.wipe();
      console.info('[clipnest-sw] scrub cache wiped');
      reply({ ok: true });
      break;
  }
});
