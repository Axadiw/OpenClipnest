/**
 * Pins the namespace-prefix split of per-user Postgres advisory locks.
 *
 * Background: until the `refactor/advisory-lock-namespace` change, every
 * code path that wanted "one writer per user" used a bare `userId` as the
 * 64-bit advisory-lock key. That meant the scanner's events-writer xact
 * lock and quotaTidy's eviction session lock could head-of-line-block each
 * other on the same `userId` even though they touch unrelated rows.
 *
 * The fix splits the key into a 32-bit purpose namespace + 32-bit userId.
 * These tests check both halves of the contract:
 *   1. Different namespaces with the same userId DO NOT collide.
 *   2. Same namespace with the same userId STILL mutually excludes.
 *
 * Real Postgres only — `pg_advisory_*` is a Postgres-specific surface.
 * Skips when no DATABASE_URL is configured.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { LOCK_NS_EVENTS, LOCK_NS_QUOTA, userLockKey, pool as realPool, __setPoolForTest } from './db/index.js';
import { withUserAdvisoryLock } from './db/queries/storage.js';

const TEST_URL =
  process.env.ADVISORY_LOCK_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('advisory lock namespace prefix', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    // max:4 — each test grabs at most 2 connections concurrently (one
    // session-scoped holder + one tx-scoped probe). Keeping the pool small
    // keeps connection bookkeeping out of the way of what we're testing.
    pool = new pg.Pool({ connectionString: TEST_URL!, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('userLockKey packs ns into the high 32 bits', () => {
    // Sanity-check the bit layout so a future "let's use bigint differently"
    // refactor that breaks this still trips the tests in CI.
    const key = userLockKey(LOCK_NS_EVENTS, 42);
    expect(key >> 32n).toBe(LOCK_NS_EVENTS);
    expect(key & 0xffffffffn).toBe(42n);
    expect(LOCK_NS_EVENTS).not.toBe(LOCK_NS_QUOTA);
  });

  it('different namespaces with same userId are independent', async () => {
    // Connection A holds a session-scoped lock on (QUOTA, 42). Connection B
    // tries to grab a tx-scoped lock on (EVENTS, 42). Pre-refactor these
    // shared the same key and B would block / `pg_try_*` would return false.
    // Post-refactor they're in different namespaces, so B succeeds.
    const userId = 42;
    const holder = await pool.connect();
    const probe = await pool.connect();
    try {
      const got = await holder.query(
        'SELECT pg_advisory_lock($1::bigint)',
        [userLockKey(LOCK_NS_QUOTA, userId).toString()],
      );
      expect(got.rowCount).toBe(1);

      await probe.query('BEGIN');
      const r = await probe.query(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [userLockKey(LOCK_NS_EVENTS, userId).toString()],
      );
      expect(r.rows[0].locked).toBe(true);
      await probe.query('COMMIT');
    } finally {
      // Release the session lock on the holder before returning the
      // connection to the pool — session locks survive connection reuse,
      // and a leaked one would poison sibling tests.
      await holder
        .query(
          'SELECT pg_advisory_unlock($1::bigint)',
          [userLockKey(LOCK_NS_QUOTA, userId).toString()],
        )
        .catch(() => undefined);
      probe.release();
      holder.release();
    }
  });

  it('same namespace with same userId still mutually excludes', async () => {
    // Symmetric to the previous test but both lockers use LOCK_NS_EVENTS.
    // This pins the "scanner full-rebuild and delta paths still serialize"
    // invariant — without it the deadlock-avoidance contract from
    // replaceUserEvents/upsertEventsDelta would silently regress.
    const userId = 99;
    const holder = await pool.connect();
    const probe = await pool.connect();
    try {
      await holder.query(
        'SELECT pg_advisory_lock($1::bigint)',
        [userLockKey(LOCK_NS_EVENTS, userId).toString()],
      );

      await probe.query('BEGIN');
      const r = await probe.query(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [userLockKey(LOCK_NS_EVENTS, userId).toString()],
      );
      expect(r.rows[0].locked).toBe(false);
      await probe.query('ROLLBACK');
    } finally {
      await holder
        .query(
          'SELECT pg_advisory_unlock($1::bigint)',
          [userLockKey(LOCK_NS_EVENTS, userId).toString()],
        )
        .catch(() => undefined);
      probe.release();
      holder.release();
    }
  });
});

// withUserAdvisoryLock holds one checked-out client for as long as its
// callback runs (minutes, for a content wipe). These pin how that client is
// treated when the connection misbehaves. A fake pool is enough: the contract
// is about listeners and release(), not about Postgres.
describe('withUserAdvisoryLock client handling', () => {
  const originalPool = realPool;
  afterEach(() => {
    __setPoolForTest(originalPool);
    vi.restoreAllMocks();
  });

  function fakeClient(opts: { unlockFails?: boolean } = {}) {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (text: string) => {
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (text.includes('pg_advisory_unlock')) {
          if (opts.unlockFails) throw new Error('Connection terminated');
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`unexpected query ${text}`);
      }),
      release: vi.fn(),
    });
    __setPoolForTest({ connect: async () => client } as unknown as pg.Pool);
    return client;
  }

  it('listens for connection errors for the whole hold, and destroys the client after one', async () => {
    const client = fakeClient();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('terminating connection due to administrator command');
    const result = await withUserAdvisoryLock(7, async () => {
      expect(client.listenerCount('error')).toBe(1);
      // Without a listener EventEmitter throws on 'error' — this would crash the process.
      client.emit('error', boom);
      return 'done';
    });
    expect(result).toBe('done');
    expect(client.listenerCount('error')).toBe(0);
    // No unlock on a dead connection; the client is destroyed, not reused.
    expect(client.query.mock.calls.some(([t]) => String(t).includes('pg_advisory_unlock'))).toBe(false);
    expect(client.release).toHaveBeenCalledWith(boom);
  });

  it('destroys the client when unlock fails, so a still-held session lock is not returned to the pool', async () => {
    const client = fakeClient({ unlockFails: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await withUserAdvisoryLock(7, async () => 'ok');
    expect(client.release).toHaveBeenCalledTimes(1);
    const arg = client.release.mock.calls[0][0] as unknown;
    expect(arg).toBeInstanceOf(Error);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('returns a healthy client to the pool after a clean unlock', async () => {
    const client = fakeClient();
    await withUserAdvisoryLock(7, async () => 'ok');
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(client.listenerCount('error')).toBe(0);
  });
});
