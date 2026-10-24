/**
 * In-process cache for the unpacked `.clean_frame` sidecar.
 *
 * Every `?fmt=clean` request (the web player and every native app ask for it) needs this
 * "recipe" before it can send its first byte: the prelude, the mdat header and the list of
 * byte runs to gather from the original recording. Until this cache existed it was fetched
 * from the object store on EVERY request: once per HEAD and once per Range GET, and a player
 * sends several of those per playback (the probe, the first range, every seek).
 *
 * Why a cache pays off, measured from inside an API pod against a remote object store
 * (random clips, sequential reads):
 *   - the sidecar is small (median 17 KiB, largest 64 KiB), so the cost is the round trip,
 *     not the transfer;
 *   - the first read of an object that has not been read lately takes 0.3-0.5 s (p90 about
 *     1 s), a repeat 50-80 ms;
 *   - and that warmth fades: about 110 ms after 30 s, about 250 ms after 120 s.
 * So a viewer who pauses or seeks pays 50-250 ms on every request for a blob that cannot
 * change underneath them.
 *
 * Why in-process and not Redis: same reasoning as sidecarCache.ts. A map lookup is ~50 us, a
 * Redis round trip ~500 us, and the value is a few KiB of data that is only ever read.
 *
 * Consistency. A sidecar is written once per recording and does not change while the
 * recording exists. The only thing that changes it is an explicit rebuild (an admin backfill,
 * run by another process), so entries expire after a TTL instead of living forever; during a
 * rebuild two API pods can disagree for up to one TTL. A sidecar the route finds stale (it
 * points past the end of the current original) is deliberately NOT dropped: such a sidecar
 * never recovers on its own, so caching it keeps that clip as cheap to serve as any other,
 * whereas dropping it would re-read it (and warm the original) on every request.
 * `invalidate()` is there for a caller that knows an entry is out of date.
 *
 * Never cached: failures. A transient error and a missing sidecar are NOT stored. A hiccup
 * must not stick, and the size rules in routes/events/video.ts rely on a missing sidecar
 * being consistently missing (a sidecar that appears a moment later has to be picked up by
 * the next request, not hidden behind a remembered miss).
 *
 * Concurrent misses share ONE load: ten viewers opening a fresh clip cost one fetch.
 *
 * Counting. A lookup is counted once, when it is answered: `hit` from memory, `miss` when it
 * went to the object store, `absent` when that load failed because the recording has no
 * sidecar. `absent` is kept apart from `miss` because it never becomes a hit (nothing is
 * stored), so left in `miss` it would drag the hit ratio down for clips the cache is not about.
 * A request that joins a load already in flight is not counted again.
 */
import { LRUCache } from 'lru-cache';
import type { CleanFrameSidecarData } from './mp4/cleanFrameSidecar.js';
import { recordCleanSidecarCache, type CleanSidecarCacheResult } from '../utils/metrics.js';

export interface CleanFrameCacheOptions {
  /** How long an entry is trusted, in ms. 0 turns the cache off: every call loads, but concurrent calls still share one load. */
  ttlMs: number;
  /** Memory budget, by `estimateSidecarBytes`. */
  maxBytes: number;
  maxEntries: number;
  /** Clock for the TTL. Tests inject their own; production uses the default. */
  perf?: { now(): number };
  /** Called once per lookup with how it was answered (for metrics). Must not throw. */
  onResult?: (result: CleanSidecarCacheResult) => void;
}

export interface CleanFrameCache {
  /**
   * `isAbsent` tells a load that failed because there is nothing to load (a missing sidecar) from one that failed
   * for any other reason; the first is counted as `absent`, the second as a `miss`. Without it every failure is a miss.
   */
  get(
    key: string,
    load: () => Promise<CleanFrameSidecarData>,
    isAbsent?: (err: unknown) => boolean,
  ): Promise<CleanFrameSidecarData>;
  /** Forget one entry, and make an in-flight load for it not store its result. Idempotent. */
  invalidate(key: string): void;
  clear(): void;
  stats(): { hits: number; misses: number; absent: number; entries: number; bytes: number };
}

/** Rough heap cost of an unpacked sidecar: its two buffers, ~48 B per run object, 8 B per frame time, plus a little overhead. */
export function estimateSidecarBytes(d: CleanFrameSidecarData): number {
  return d.prelude.length + d.mdatHeader.length + d.byteRanges.length * 48 + d.frameGrid.length * 8 + 256;
}

export function createCleanFrameSidecarCache(opts: CleanFrameCacheOptions): CleanFrameCache {
  const enabled = opts.ttlMs > 0;
  // lru-cache treats `ttl: 0` as "never expires", so a disabled cache must not be built with it.
  const lru = new LRUCache<string, CleanFrameSidecarData>({
    max: opts.maxEntries,
    maxSize: opts.maxBytes,
    sizeCalculation: estimateSidecarBytes,
    ttl: enabled ? opts.ttlMs : 1,
    // By default lru-cache re-reads the clock at most once per real millisecond. With an injected test clock
    // that would let a lookup see a stale "now", so check it on every lookup instead.
    ...(opts.perf && { perf: opts.perf, ttlResolution: 0 }),
  });
  const inflight = new Map<string, Promise<CleanFrameSidecarData>>();
  let hits = 0;
  let misses = 0;
  let absent = 0;
  const note = (r: CleanSidecarCacheResult): void => {
    if (r === 'hit') hits++; else if (r === 'miss') misses++; else absent++;
    opts.onResult?.(r);
  };

  return {
    get(key, load, isAbsent) {
      if (enabled) {
        const cached = lru.get(key);
        if (cached) {
          note('hit');
          return Promise.resolve(cached);
        }
      }
      const pending = inflight.get(key);
      if (pending) return pending;

      // `p` is both the in-flight marker and what the caller awaits; comparing against it is how a
      // result that lost a race with invalidate() is recognised and left out of the cache. The lookup
      // is counted when the load settles, because only then is it known whether the sidecar exists.
      const p: Promise<CleanFrameSidecarData> = load()
        .then(
          (value) => {
            note('miss');
            if (enabled && inflight.get(key) === p) lru.set(key, value);
            return value;
          },
          (err: unknown) => {
            note(isAbsent?.(err) ? 'absent' : 'miss');
            throw err;
          },
        )
        .finally(() => {
          if (inflight.get(key) === p) inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    },
    invalidate(key) {
      lru.delete(key);
      inflight.delete(key);
    },
    clear() {
      lru.clear();
      inflight.clear();
      hits = 0;
      misses = 0;
      absent = 0;
    },
    stats() {
      return { hits, misses, absent, entries: lru.size, bytes: lru.calculatedSize };
    },
  };
}

const envInt = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The process-wide cache. `CLEAN_FRAME_CACHE_TTL_MS=0` turns it off. */
export const cleanFrameSidecarCache = createCleanFrameSidecarCache({
  ttlMs: envInt('CLEAN_FRAME_CACHE_TTL_MS', 5 * 60 * 1000),
  maxBytes: envInt('CLEAN_FRAME_CACHE_MAX_BYTES', 64 * 1024 * 1024),
  maxEntries: envInt('CLEAN_FRAME_CACHE_MAX_ENTRIES', 20_000),
  onResult: recordCleanSidecarCache,
});
