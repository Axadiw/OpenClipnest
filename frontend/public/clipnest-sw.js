/* Clipnest service worker.
 *
 * Caches the SPA app shell (index.html + static assets) so that a phone with
 * no signal can still open Clipnest and see the landing/login surface.
 * Video endpoints are streamed directly from the upstream source.
 */

// === PWA app-shell cache ===
// The SPA bootstrap (index.html + a handful of static assets) is the
// "shell" — a phone with no signal can still open Clipnest and see the
// landing/login surface as long as these are cached. Bump the version
// suffix every time we change SHELL_URLS or the SW logic so old shells
// get reaped on activate.
const SHELL_CACHE = 'clipnest-shell-v1';
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

self.addEventListener('install', (event) => {
  // Take over from the previous SW build immediately; we don't have
  // long-lived background work that would benefit from waiting.
  self.skipWaiting();
  // Precache the app shell. addAll is atomic — if any URL fails the
  // whole install fails and the previous SW stays in charge. That's
  // the right failure mode (we'd rather keep working old shell than
  // ship a half-baked one).
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
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
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Top-level navigation (HTML page load). Network-first so the freshest
  // SPA shell wins, but fall back to the cached `/` shell when offline so
  // a phone with no signal still gets the app instead of the browser's
  // dino page. Cached SPA bundle then bootstraps the route client-side.
  if (event.request.mode === 'navigate') {
    event.respondWith(navigateWithShellFallback(event.request));
    return;
  }
});

async function navigateWithShellFallback(request) {
  try {
    const fresh = await fetch(request);
    return fresh;
  } catch {
    // No network. Serve the cached `/` shell — the SPA's pathname-based
    // router will still pick up the original URL once it boots.
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match('/');
    if (cached) return cached;
    // Shell never made it into cache (rare — first-load offline). Return
    // a minimal placeholder so the user sees something rather than the
    // generic browser error.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Clipnest — offline</title>'
      + '<body style="background:#06070C;color:#E6E9F0;font-family:system-ui;text-align:center;padding:40vh 16px;">'
      + '<h1>You\'re offline</h1><p>Clipnest needs a network connection to load. Try again in a moment.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

