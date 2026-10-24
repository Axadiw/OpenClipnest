/**
 * Page side of the scrub-preview service worker (`src/sw/clipnest-sw.ts`). Every call is a
 * no-op when no worker controls the page (first visit before it activates, blocked workers,
 * private modes): the players then simply fetch from the network as before.
 */
import type { ByteRange } from '../byteRanges';
import { videoCacheKey } from '../../sw/videoRequest';

const WIPE_TIMEOUT_MS = 500;
/**
 * How often a live subscription asks the worker for its current ranges. The worker stops when
 * idle (~30 s) or is replaced by a release, losing its memory without telling anyone; asking
 * wakes it, and its fresh (new-epoch, empty) answer clears stretches that are no longer cached.
 */
const RANGES_REQUERY_MS = 10_000;

function controller(): ServiceWorker | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.serviceWorker?.controller ?? null;
}

const MiB = 1024 * 1024;

/**
 * The worker's memory budget this page asks for: 64 MiB on touch-first devices (phones and
 * tablets, where WebKit pulls the whole clip through the worker and memory is tight), 256 MiB
 * otherwise. The worker keeps the smallest value any page asked for since it started.
 */
export function scrubCacheMaxBytes(): number {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return (coarse ? 64 : 256) * MiB;
}

/** Tells the controlling worker this page's memory budget. A no-op without one. */
function sendConfig(sw: ServiceWorker | null = controller()): void {
  sw?.postMessage({ type: 'scrub:config', maxBytes: scrubCacheMaxBytes() });
}

/**
 * Registers `/clipnest-sw.js` once the page has loaded, and sends the memory budget to it and to
 * every worker that later takes control. Failures are ignored.
 */
export function registerScrubServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => sendConfig());
  const register = () => {
    navigator.serviceWorker
      .register('/clipnest-sw.js', { scope: '/', updateViaCache: 'none' })
      .then(() => sendConfig())
      .catch(() => { /* no worker: playback goes straight to the network */ });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** True when a worker controls this page, i.e. video reads go through the shared cache. */
export function isScrubCacheActive(): boolean {
  return controller() !== null;
}

/**
 * Asks the worker to cache `[r.start, r.end)` of a clean-video URL at preview priority.
 * Resolves `true` once cached; `false` without a worker, on an error or when `signal` aborts
 * (which also cancels the worker's fetch). A new prefetch replaces this page's previous one.
 */
export function prefetchRange(url: string, r: ByteRange, signal: AbortSignal): Promise<boolean> {
  const sw = controller();
  if (!sw || signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const finish = (ok: boolean) => {
      signal.removeEventListener('abort', onAbort);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(ok);
    };
    const onAbort = () => {
      sw.postMessage({ type: 'scrub:cancel' });
      finish(false);
    };
    channel.port1.onmessage = (e: MessageEvent<{ ok?: boolean }>) => finish(e.data?.ok === true);
    signal.addEventListener('abort', onAbort, { once: true });
    sw.postMessage({ type: 'scrub:prefetch', url, start: r.start, end: r.end }, [channel.port2]);
  });
}

/** Frees the cached bytes of a recording (its player closed). */
export function dropRecording(url: string): void {
  const key = videoCacheKey(url);
  const sw = controller();
  if (key && sw) sw.postMessage({ type: 'scrub:drop', key });
}

const wipeListeners = new Set<() => void>();

/** Calls `cb` (synchronously) whenever `wipeScrubCache` runs, for page-side caches with the same lifetime. */
export function onScrubCacheWipe(cb: () => void): () => void {
  wipeListeners.add(cb);
  return () => { wipeListeners.delete(cb); };
}

/** Frees every cached byte (sign-out). Resolves within 500 ms, worker or not. */
export function wipeScrubCache(): Promise<void> {
  for (const cb of [...wipeListeners]) {
    try { cb(); } catch { /* one listener must not keep the others from wiping */ }
  }
  const sw = controller();
  if (!sw) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const done = () => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve();
    };
    const timer = setTimeout(done, WIPE_TIMEOUT_MS);
    channel.port1.onmessage = done;
    sw.postMessage({ type: 'scrub:wipe' }, [channel.port2]);
  });
}

const liveQueries = new Set<() => void>();

/** Asks the worker again for the cached ranges of every live subscription (the preview bubble opened). */
export function refreshCachedRanges(): void {
  for (const q of [...liveQueries]) q();
}

type RangesMessage = { type: 'scrub:ranges'; key: string; total: number; ranges: ByteRange[]; seq?: number; epoch?: string };

/** Calls `cb` whenever the worker's cached ranges of this recording change. Returns the unsubscribe. */
export function subscribeCachedRanges(
  url: string, cb: (r: { total: number; ranges: ByteRange[] }) => void,
): () => void {
  const key = videoCacheKey(url);
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!key || !container) return () => {};
  // The reply to the query (MessagePort) and the change announcements travel separately and
  // can arrive in either order; anything older than what was already delivered is dropped.
  // The counter restarts from 0 when the worker restarts, so it is compared within one epoch only.
  let lastSeq = -1;
  let lastEpoch = '';
  const deliver = (total: number, ranges: ByteRange[], seq: number | undefined, epoch: string | undefined) => {
    const n = seq ?? 0;
    const ep = epoch ?? '';
    if (ep === lastEpoch && n < lastSeq) return;
    lastEpoch = ep;
    lastSeq = n;
    cb({ total, ranges });
  };
  const onMessage = (e: MessageEvent<RangesMessage>) => {
    const d = e.data;
    if (d?.type === 'scrub:ranges' && d.key === key) deliver(d.total, d.ranges, d.seq, d.epoch);
  };
  container.addEventListener('message', onMessage);
  // The worker only announces changes; ask for the current state now (it outlives page
  // reloads), when another worker takes over, every RANGES_REQUERY_MS and on `refreshCachedRanges`.
  const channels = new Set<MessageChannel>();
  const close = (ch: MessageChannel) => {
    ch.port1.onmessage = null;
    ch.port1.close();
    channels.delete(ch);
  };
  const query = () => {
    const sw = controller();
    if (!sw) return;
    // A restarted worker has forgotten the budget too: repeat it with every query.
    sendConfig(sw);
    const ch = new MessageChannel();
    channels.add(ch);
    ch.port1.onmessage = (e: MessageEvent<{ total?: number; ranges?: ByteRange[]; seq?: number; epoch?: string }>) => {
      close(ch);
      if (Array.isArray(e.data?.ranges)) deliver(e.data.total ?? 0, e.data.ranges, e.data.seq, e.data.epoch);
    };
    sw.postMessage({ type: 'scrub:ranges?', key }, [ch.port2]);
  };
  query();
  container.addEventListener('controllerchange', query);
  const timer = setInterval(query, RANGES_REQUERY_MS);
  liveQueries.add(query);
  return () => {
    container.removeEventListener('message', onMessage);
    container.removeEventListener('controllerchange', query);
    clearInterval(timer);
    liveQueries.delete(query);
    for (const ch of [...channels]) close(ch);
  };
}
