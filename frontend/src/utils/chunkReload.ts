// Recovery from stale code-split chunks after a deploy.
//
// Every React.lazy() route is built into a content-hashed chunk under /assets/.
// A production deploy replaces the whole nginx image, so the previous hashes
// 404 (nginx has no /assets/ fallback). A browser tab opened before the deploy
// still holds the old index.html, so navigating to a not-yet-loaded route
// imports a chunk that no longer exists — the dynamic import rejects with
// "error loading dynamically imported module" and React Router surfaces it.
//
// Vite fires a `vite:preloadError` window event when its preload helper fails.
// We reload the page once to pull the fresh index.html (and with it the new
// chunk hashes). A sessionStorage timestamp guards against a reload loop when
// the reload itself can't recover (genuine offline / server down).

const RELOAD_GUARD_KEY = 'clipnest:chunkReloadAt';

// Auto-reload at most once per this window; a second failure inside it means
// the reload didn't fix things, so we stop and let the error surface.
export const RELOAD_GUARD_MS = 10_000;

// The browser-specific phrasings of a failed dynamic import. Matching on the
// message keeps this independent of the (varying) Error subtype.
const CHUNK_ERROR_PATTERNS = [
  /loading dynamically imported module/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /error loading chunk/i,
  /unable to preload css/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return false;
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message));
}

export interface ReloadGuardDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  now: number;
}

// Returns true at most once per RELOAD_GUARD_MS and records the attempt, so a
// post-reload repeat of the same failure won't loop. `now`/`storage` are
// injected to keep this pure and testable.
export function shouldReloadOnce({ storage, now }: ReloadGuardDeps): boolean {
  const raw = storage.getItem(RELOAD_GUARD_KEY);
  const last = raw == null ? null : Number(raw);
  if (last != null && Number.isFinite(last) && now - last < RELOAD_GUARD_MS) {
    return false;
  }
  storage.setItem(RELOAD_GUARD_KEY, String(now));
  return true;
}

// Wire the window listener. Call once at startup. The RouteErrorBoundary is the
// fallback for the residual case where the guard blocks the reload.
export function installChunkReloadHandler(): void {
  window.addEventListener('vite:preloadError', () => {
    if (shouldReloadOnce({ storage: sessionStorage, now: Date.now() })) {
      window.location.reload();
    }
  });
}
