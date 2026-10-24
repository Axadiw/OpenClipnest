/**
 * Drizzle ORM access layer for the Clipnest server.
 *
 * - Drizzle wraps a new pg.Pool with identical config to the legacy
 *   server/db.ts pool (max=20, connectionString from CONFIG.databaseUrl),
 *   so there's only ever one pool per module — until Task 22 both pools
 *   coexist; mismatched config would be a bug.
 * - withTx wraps a Drizzle transaction with timing (slow-tx breadcrumb
 *   mirrors the pattern used elsewhere in the codebase).
 * - withUserLock takes a (namespace, internalUserId) and serializes work on
 *   that user via pg_advisory_xact_lock inside a transaction.
 * - LOCK_NS_EVENTS and LOCK_NS_QUOTA MUST match the values in the legacy
 *   server/db.ts — both layers stay live during query migration (Tasks 11-15)
 *   and mixed usage of the same lock namespace must produce the same key.
 *
 * Test helper __setPoolForTest mirrors the legacy db.ts behaviour.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { addBreadcrumb, captureException } from '../errorReporting.js';
import { CONFIG } from '../config.js';
import * as schema from './schema/index.js';

// Re-export schema so callers can `import { users, events } from '../db'`
export * from './schema/index.js';

// -------- Pool config — MUST match server/db.ts EXACTLY --------
// server/db.ts: new Pool({ connectionString: CONFIG.databaseUrl, max: 20 })
// No explicit idleTimeoutMillis / connectionTimeoutMillis in legacy — keep parity.
function makePool(): Pool {
  return new Pool({ connectionString: CONFIG.databaseUrl, max: 20 });
}

export let pool = makePool();

pool.on('error', (err) => {
  // Capture unexpected pool-level errors — same defensive pattern used
  // throughout the codebase for unexpected async errors.
  captureException(err);
});

// -------- Drizzle instance --------
// logger: true emits to console when DRIZZLE_LOG=1; silent otherwise.
function makeDb(p: Pool): NodePgDatabase<typeof schema> {
  return drizzle(p, {
    schema,
    logger: process.env.DRIZZLE_LOG === '1',
  });
}

export let db: NodePgDatabase<typeof schema> = makeDb(pool);

// -------- Test helper — swap the pool (mirrors legacy __setPoolForTest) --------
// Tests that call db.test.ts's __setPoolForTest on the legacy layer still work
// unchanged. This helper exists for future query paths that go through this
// new module.
export function __setPoolForTest(testPool: Pool): void {
  pool = testPool;
  db = makeDb(pool);
}

// -------- Tx type alias for callbacks --------
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// -------- Advisory lock namespaces — bit-identical to server/db.ts --------
// Postgres advisory locks are 64-bit. Split: high 32 bits = purpose namespace,
// low 32 bits = userId. Different purposes never collide, even on the same userId.
// ASCII-derived prefixes so they show up readable in `pg_locks` query output.
//
// LOCK_NS_EVENTS covers all writers that touch `events` rows for a given owner.
// LOCK_NS_QUOTA is independent — used by quotaTidy's withUserAdvisoryLock.
export const LOCK_NS_EVENTS = 0x4556544en; // 'EVTN'
export const LOCK_NS_QUOTA  = 0x51544459n; // 'QTDY'
// LOCK_NS_SUBSCRIPTION serializes mirroring a user's payment subscriptions
// (read from the provider + write) so the last write is the last read.
export const LOCK_NS_SUBSCRIPTION = 0x53554253n; // 'SUBS'

// -------- userLockKey — bit-identical to server/db.ts --------
export function userLockKey(ns: bigint, userId: number): bigint {
  return (ns << 32n) | BigInt(userId);
}

// -------- withTx — Drizzle transaction with a slow-tx breadcrumb --------
const SLOW_TX_MS = 1000; // log transactions that take longer than 1s

export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await db.transaction(fn);
  } finally {
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_TX_MS) {
      addBreadcrumb({
        category: 'db.slow-tx',
        level: 'warning',
        data: { elapsed_ms: Math.round(elapsed) },
      });
    }
  }
}

// -------- withUserLock — per-user transactional advisory lock --------
// Acquires pg_advisory_xact_lock for (ns, userId) inside a transaction so
// the lock auto-releases on COMMIT/ROLLBACK.
//
// `opts.lockTimeoutMs` caps the wait for the lock itself (SET LOCAL
// lock_timeout, applied before acquiring); a busy lock then fails with
// 55P03 instead of queueing indefinitely. It does NOT bound what the callback
// does once the lock is held — a callback that waits on a remote call must
// set its own deadline. (Deliberately no idle_in_transaction_session_timeout:
// Postgres ends the session when it fires, and the error surfaces on a client
// the pool no longer listens to — an unhandled 'error' event.)
//
// Defence in depth: for the life of the transaction a listener is attached to
// the checked-out client (pg-pool drops its own on checkout), so a server-side
// session end while the lock is held is logged and the in-flight query rejects
// instead of an unhandled 'error' event taking the process down.
export interface UserLockOptions {
  lockTimeoutMs?: number;
}

type ErrorEmitter = { on(e: 'error', l: (err: Error) => void): unknown; removeListener(e: 'error', l: (err: Error) => void): unknown };

/** The pg client behind a Drizzle transaction, when the driver exposes it. */
function txClient(tx: Tx): ErrorEmitter | null {
  const client = (tx as unknown as { session?: { client?: unknown } }).session?.client as Partial<ErrorEmitter> | undefined;
  return client && typeof client.on === 'function' && typeof client.removeListener === 'function' ? client as ErrorEmitter : null;
}

export async function withUserLock<T>(
  ns: bigint,
  userId: number,
  fn: (tx: Tx) => Promise<T>,
  opts: UserLockOptions = {},
): Promise<T> {
  return withTx(async (tx) => {
    const client = txClient(tx);
    const onError = (err: Error) => {
      console.error('[db] connection error while holding a user lock:', err.message);
    };
    client?.on('error', onError);
    try {
      if (opts.lockTimeoutMs !== undefined) {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(opts.lockTimeoutMs))}`));
      }
      const key = userLockKey(ns, userId);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key}::bigint)`);
      return await fn(tx);
    } finally {
      client?.removeListener('error', onError);
    }
  });
}

// -------- pingDb — health-check helper used by /api/v0/health --------
export async function pingDb(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

// -------- initDb — startup bootstrap (replaces legacy server/db.ts initDb) --------
// Pings the DB, optionally runs migrations, initialises the JWT secret cache.
// Lazy-imported to avoid a circular dep with db/queries/settings.ts at module load.
//
// `RUN_MIGRATE_AT_STARTUP=true` (local dev / e2e-backend compose) triggers a
// drizzle-orm migrator run before anything else touches the DB. Production
// pods boot with `RUN_MIGRATE_AT_STARTUP=false` and rely on the dedicated
// `clipnest-migrate` k8s Job (see `server/scripts/migrate.ts`) having run
// once per release. This matches the legacy behaviour from the pre-Drizzle
// `server/db.ts` initDb.
export async function initDb(): Promise<void> {
  await pingDb();
  const runMigrate = (process.env.RUN_MIGRATE_AT_STARTUP ?? '').toLowerCase() === 'true';
  if (runMigrate) {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    await migrate(db, { migrationsFolder: join(__dirname, 'migrations') });
  }
  const { initJwtSecret } = await import('./queries/settings.js');
  await initJwtSecret();
}
