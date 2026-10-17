/**
 * Unit tests for the per-process UUID→internal-id cache.
 *
 * The cache exists so the event-manager delete-notify burst (concurrency=50
 * × 3 pods) doesn't hammer Postgres with redundant `SELECT id FROM users
 * WHERE uuid=$1` for the same handful of users. These tests pin the
 * behaviour we care about: a hot uuid hits memory; an unknown uuid is
 * negatively cached briefly so we don't retry-loop into the DB; concurrent
 * misses for the same uuid both call the lookup but the second result
 * still ends up cached.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedUserInternalId,
  __resetUserIdCacheForTest,
  __userIdCacheSizeForTest,
} from './userIdCache.js';

describe('userIdCache', () => {
  beforeEach(() => {
    __resetUserIdCacheForTest();
  });

  it('calls the lookup once for a hit and serves subsequent hits from memory', async () => {
    const lookup = vi.fn().mockResolvedValue(42);
    const first = await getCachedUserInternalId('uuid-a', lookup);
    const second = await getCachedUserInternalId('uuid-a', lookup);
    const third = await getCachedUserInternalId('uuid-a', lookup);

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(third).toBe(42);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('caches null lookups so repeat misses do not hit the DB in a tight loop', async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const first = await getCachedUserInternalId('uuid-missing', lookup);
    const second = await getCachedUserInternalId('uuid-missing', lookup);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('isolates cache entries per uuid', async () => {
    const lookup = vi.fn((u: string) => Promise.resolve(u === 'a' ? 1 : 2));
    expect(await getCachedUserInternalId('a', lookup)).toBe(1);
    expect(await getCachedUserInternalId('b', lookup)).toBe(2);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(__userIdCacheSizeForTest()).toBe(2);
  });

  it('re-fetches after the hit TTL expires (immutable in practice, bounded for safety)', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn().mockResolvedValue(7);
      expect(await getCachedUserInternalId('uuid-ttl', lookup)).toBe(7);
      // Just under TTL: still a hit.
      vi.advanceTimersByTime(5 * 60_000 - 1);
      expect(await getCachedUserInternalId('uuid-ttl', lookup)).toBe(7);
      expect(lookup).toHaveBeenCalledTimes(1);
      // Past TTL: refetch.
      vi.advanceTimersByTime(2);
      expect(await getCachedUserInternalId('uuid-ttl', lookup)).toBe(7);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-fetches a previously-missing uuid after the shorter miss TTL', async () => {
    vi.useFakeTimers();
    try {
      // First, the user does not exist.
      const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(99);
      expect(await getCachedUserInternalId('uuid-late', lookup)).toBeNull();
      vi.advanceTimersByTime(29_000);
      // Still inside miss TTL.
      expect(await getCachedUserInternalId('uuid-late', lookup)).toBeNull();
      expect(lookup).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      // Past miss TTL — retry and discover the user now exists.
      expect(await getCachedUserInternalId('uuid-late', lookup)).toBe(99);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates lookup errors without caching them', async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('db unreachable'))
      .mockResolvedValueOnce(5);
    await expect(getCachedUserInternalId('uuid-err', lookup)).rejects.toThrow('db unreachable');
    // Error must not have cached anything — next call retries.
    expect(__userIdCacheSizeForTest()).toBe(0);
    expect(await getCachedUserInternalId('uuid-err', lookup)).toBe(5);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
