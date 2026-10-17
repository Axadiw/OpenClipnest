import type { RangeFetcher } from './fragmentIndex.js';

// ---------------------------------------------------------------------------
// cachingFetcher — per-file interval cache for S3 range fetches.
//
// Purpose: when building the .fmp4patch, .clean_frame and .frames sidecars for
// the same file, the builders walk the moof fragment chain and fetch the same
// ~16 KB moof headers from S3. This wrapper memoizes fetched [start,end]
// intervals so that later walkers (parseAllSamples for clean_frame/frames) hit
// the cache populated by the first walker (indexFragmentedMp4) — collapsing the
// per-file S3 Range GETs from ~N per builder down to ~N total.
//
// Design constraints:
//   - Correctness: a cache-hit MUST return exactly the same bytes as calling
//     inner(start, end) would — byte-identical slice of the cached buffer.
//   - Simplicity: linear scan is fine; N ≤ a few hundred per file.
//   - Scope: created per-file and discarded after — NO cross-file state.
//   - No cap: moof headers cached for one file are ~16KB×N ≈ <1 MB; no eviction.
// ---------------------------------------------------------------------------

interface CachedInterval {
  start: number;
  end: number; // inclusive
  buf: Buffer;
}

export interface CachingFetcher extends RangeFetcher {
  stats(): { hits: number; misses: number; bytesFetched: number };
}

/**
 * Wraps a `RangeFetcher` with a per-instance interval cache. Returned fetcher
 * is a function with an extra `.stats()` method for observability / testing.
 *
 * Cache semantics: if any previously-fetched interval [cached.start, cached.end]
 * fully covers the requested [s, e] (`cached.start <= s && cached.end >= e`),
 * a sub-slice of the cached buffer is returned without calling `inner`. Otherwise
 * `inner(s, e)` is called, the result is stored, and returned.
 *
 * The returned buffer for a cache hit is exactly `buf.subarray(s - cached.start,
 * e - cached.start + 1)` — length `(e - s + 1)`, byte-identical to what `inner`
 * would return for an inclusive [s, e] range.
 */
export function createCachingFetcher(inner: RangeFetcher): CachingFetcher {
  const cache: CachedInterval[] = [];
  let hits = 0;
  let misses = 0;
  let bytesFetched = 0;

  const fetcher = async (s: number, e: number): Promise<Buffer> => {
    // Linear scan — N is small (≤ a few hundred moof headers per file).
    for (const interval of cache) {
      if (interval.start <= s && interval.end >= e) {
        // Cache hit: return an exact [s, e] slice of the cached buffer.
        hits++;
        // subarray is zero-copy but shares memory — that's fine; callers only
        // read from it, and parseMoofSamples / parseMoofAndMdatHeaders never
        // mutate the buffer they receive. Wrap in Buffer.from if we ever see
        // mutation — for now subarray matches the contract.
        return interval.buf.subarray(s - interval.start, e - interval.start + 1);
      }
    }

    // Cache miss: fetch from inner and store.
    misses++;
    const buf = await inner(s, e);
    bytesFetched += buf.length;
    cache.push({ start: s, end: e, buf });
    return buf;
  };

  fetcher.stats = (): { hits: number; misses: number; bytesFetched: number } => ({
    hits,
    misses,
    bytesFetched,
  });

  return fetcher as CachingFetcher;
}
