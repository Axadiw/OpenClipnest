/**
 * In-process LRU cache for the mdat zone of the fmp4-patched MP4 — i.e. the
 * full S3 GetObject body that `streamPatchedMp4` would normally range-read
 * on every request. Caching this byte stream eliminates the ONE remaining
 * S3 sub-call per `/video/:view` request (`headObject` is Redis-cached as
 * of v0.10.272, the sidecar is in-memory cached, and the patched-mp4
 * prelude / sidx / mfra all come from the sidecar). Range requests get
 * served by slicing the cached `Buffer`.
 *
 * Wedge fix lineage:
 *
 *   v0.10.211 baseline → wedge in ~70 s under 100 VU
 *   v0.10.268 cap=50    → 0 wedge (cap fires) but blocks legitimate users
 *   v0.10.272 head cache → eliminates 1 of 3 S3 sub-calls; wedge still
 *                          appears because the streaming mdat call still
 *                          eats a pool slot per request
 *   v0.10.273 (this)    → cache mdat bytes too; warm fan-out per request
 *                          drops to ZERO S3 calls. Stress survives 100 VU.
 *
 * Cap sizing:
 *
 *   Reolink wide+zoom clips are ~5-30 MB. With 20 unique events targeted
 *   by the stress reproducer the warm cache footprint is at most
 *   20 × 30 MB = 600 MB. Production load is more spread (hundreds of
 *   unique events across users) so the LRU eviction is the real bound:
 *   `MDAT_CACHE_MAX_BYTES` (default 500 MB) caps total memory and the LRU
 *   policy keeps the hot set resident. Pod memory limit is 2 Gi; 500 MB
 *   leaves comfortable headroom for the Node heap, native socket buffers,
 *   thumbnails LRU, etc.
 *
 *   Files larger than `MDAT_CACHE_MAX_FILE_BYTES` (default 50 MB) skip the
 *   cache entirely and fall back to the legacy S3 range-read path — the
 *   memory cost of caching a single 100 MB file isn't worth the eviction
 *   churn it causes for the smaller hot set.
 *
 * Concurrent-miss dedup:
 *
 *   When N requests for the same cold event arrive simultaneously (every
 *   stress run starts this way; in production it's the "deep-link to a
 *   viral clip" scenario), we fire ONE full-body `getObject` and have
 *   everyone await the same Promise. Without dedup, 100 cold requests
 *   for one popular event would each pull the full mp4 from S3 — exactly
 *   the wedge that this cache is meant to prevent. Pattern lifted from
 *   `services/sidecarCache.ts`.
 *
 * Per-user scoping (cache key includes a salt hash):
 *
 *   S3 SSE-C makes the on-disk bytes specific to the encryption key
 *   derived from the user's salt. Same (bucket, key) pulled with a
 *   DIFFERENT salt yields a different plaintext, so the cache must be
 *   keyed per user — otherwise user B querying the same s3 key as user A
 *   would get user A's plaintext from the cache. In practice this only
 *   matters defensively (the route-level ownership check in
 *   `resolveS3Path` already scopes s3 keys per user UUID, so no user
 *   can legitimately request another's key), but cache poisoning is the
 *   kind of thing we want to make impossible at the cache layer too.
 */
import { LRUCache } from 'lru-cache';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import type { Readable } from 'stream';

const MAX_BYTES = parseInt(
  process.env.MDAT_CACHE_MAX_BYTES || String(500 * 1024 * 1024),
  10,
);
const MAX_FILE_BYTES = parseInt(
  process.env.MDAT_CACHE_MAX_FILE_BYTES || String(50 * 1024 * 1024),
  10,
);

const cache = new LRUCache<string, Buffer>({
  maxSize: MAX_BYTES,
  sizeCalculation: (buf) => buf.length,
});

const inflight = new Map<string, Promise<Buffer>>();

/** Build the cache key. Salt is hashed (sha256, 16-hex prefix) so we
 *  don't store the raw secret inside the cache map keys.  */
export function buildMdatCacheKey(bucket: string, key: string, userSalt: string): string {
  const saltHash = createHash('sha256').update(userSalt).digest('hex').slice(0, 16);
  return `${bucket}:${key}:${saltHash}`;
}

/**
 * Drain a Readable into a Buffer, refusing to keep anything larger than
 * `MAX_FILE_BYTES`. Returning `null` (rather than throwing) lets the caller
 * fall through to the legacy range-read path — a missing cache entry is a
 * fast-path miss, not an application error.
 */
async function streamToBufferOrNull(stream: Readable): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > MAX_FILE_BYTES) {
      // Drain the rest of the stream so the underlying S3 socket releases.
      stream.destroy();
      return null;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

export interface MdatCacheFetcher {
  /**
   * Caller-supplied loader. The caller decides whether to do a full GET
   * (no range) — the cache layer just receives a Readable. The Readable
   * will be fully consumed before this function resolves.
   */
  (): Promise<Readable>;
}

/**
 * Look up the full mdat zone for a (bucket, key, userSalt). On hit, the
 * Buffer is returned synchronously (well, in a microtask). On miss, the
 * fetcher is invoked, its body drained to Buffer, and the result is
 * cached if it fits inside `MAX_FILE_BYTES`.
 *
 * Returns `null` when:
 *   - The decrypted body exceeds `MAX_FILE_BYTES` (skip-cache path)
 *   - The fetcher threw (the error is rethrown via the inflight Promise)
 *
 * Concurrent misses for the same key share one fetch — the inflight Map
 * acts as a per-key mutex, lifted from the same pattern in sidecarCache.
 */
export async function getCachedMdat(
  cacheKey: string,
  fileSize: number,
  fetcher: MdatCacheFetcher,
): Promise<Buffer | null> {
  if (fileSize > MAX_FILE_BYTES) return null;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const body = await fetcher();
    return streamToBufferOrNull(body);
  })()
    .then((buf) => {
      if (buf) cache.set(cacheKey, buf);
      return buf;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });
  // We only put the resolved-buffer variant into inflight — null returns
  // from streamToBufferOrNull are NOT cached and the next caller will
  // re-attempt (which they probably should; oversized files are unusual).
  inflight.set(cacheKey, promise as Promise<Buffer>);
  return promise;
}

/**
 * Salt-agnostic invalidation. The cache key embeds a sha256(salt)[:16]
 * suffix, but a generic `deleteObject(bucket, key)` doesn't have the
 * caller's salt at hand. Iterating the LRU keyspace once per delete is
 * cheap (the cache is bounded by `MAX_BYTES` so worst-case it holds tens
 * of entries), and the alternative — propagating the salt all the way
 * down to `s3.deleteObject` — would force a breaking change on every
 * delete-flow caller (userDeletionWorker, storageReconciler, etc.) for
 * a follow-up to the wedge fix. Returns the number of entries evicted
 * so the caller can log the impact if useful.
 *
 * In practice each (bucket, key) pair has at most one cached entry — a
 * single user owns each key (route-level `resolveS3Path` scopes by
 * userUuid) — but the loop handles the multi-owner edge case defensively
 * for free.
 */
export function invalidateMdatByBucketKey(bucket: string, key: string): number {
  const prefix = `${bucket}:${key}:`;
  let count = 0;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) {
      cache.delete(k);
      count += 1;
    }
  }
  return count;
}
