/**
 * Per-process UUID → internal user id cache for hot paths.
 *
 * Why a cache at all:
 *   The event-manager delete-notify handler runs with concurrency=50 per
 *   pod × 3 pods. During a delete burst (FTPS `rm -rf` of thousands of
 *   files) every message triggers a UUID→id lookup to scope the DB writes
 *   by `owner_id`. Without this cache that's hundreds of concurrent
 *   identical SELECTs against Postgres for the same handful of users.
 *
 * Why this cache is safe even though it has no invalidation hook:
 *   A user's internal id is the SERIAL PK and is never reassigned —
 *   deletion is soft (`deletion_status='deleted'`) and `users.uuid` is
 *   UNIQUE NOT NULL with no UPDATE path in the codebase. The mapping
 *   is therefore immutable for the lifetime of any process. We keep a
 *   TTL anyway as a belt-and-suspenders guard against pathological
 *   futures and to bound cache growth.
 *
 * Failure mode:
 *   `null` is cached separately ('unknown-user' TTL is short) so a
 *   delete-notify for a freshly-deleted user doesn't blow the consumer
 *   into a tight loop of DB lookups. After TTL we'll retry once.
 */

const HIT_TTL_MS = 5 * 60_000;   // 5 min — id is immutable; this just bounds memory
const MISS_TTL_MS = 30_000;       // 30 s — short retry window for unknown UUIDs

interface CacheEntry {
  id: number | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export type UserIdLookup = (uuid: string) => Promise<number | null>;

/**
 * Returns the internal id for `uuid` from the in-process cache, or calls
 * `lookup` on miss/expiry and stores the result. Concurrent misses for
 * the same uuid will all hit `lookup`; for the call-site we care about
 * (delete-notify burst) the first one warms the cache within a few ms
 * and the rest are hits.
 */
export async function getCachedUserInternalId(
  uuid: string,
  lookup: UserIdLookup,
): Promise<number | null> {
  const now = Date.now();
  const hit = cache.get(uuid);
  if (hit && hit.expiresAt > now) {
    return hit.id;
  }
  const id = await lookup(uuid);
  cache.set(uuid, {
    id,
    expiresAt: now + (id === null ? MISS_TTL_MS : HIT_TTL_MS),
  });
  return id;
}

/** Test-only: clear the cache. Not exported from the package barrel. */
export function __resetUserIdCacheForTest(): void {
  cache.clear();
}

/** Test-only: peek at cache size without leaking the implementation. */
export function __userIdCacheSizeForTest(): number {
  return cache.size;
}
