/**
 * Drizzle ORM access layer for the Clipnest server.
 *
 * - Drizzle wraps a new pg.Pool with identical config to the legacy
 *   server/db.ts pool (max=20, connectionString from CONFIG.databaseUrl),
 *   so there's only ever one pool per module — until Task 22 both pools
 *   coexist; mismatched config would be a bug.
 * - withTx wraps a Drizzle transaction with Sentry timing (slow-tx breadcrumb
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
import * as Sentry from '@sentry/node';
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
  Sentry.captureException(err);
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

// -------- userLockKey — bit-identical to server/db.ts --------
export function userLockKey(ns: bigint, userId: number): bigint {
  return (ns << 32n) | BigInt(userId);
}

// -------- withTx — Drizzle transaction with Sentry slow-tx breadcrumb --------
const SLOW_TX_MS = 1000; // log transactions that take longer than 1s

export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await db.transaction(fn);
  } finally {
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_TX_MS) {
      Sentry.addBreadcrumb({
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
export async function withUserLock<T>(
  ns: bigint,
  userId: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTx(async (tx) => {
    const key = userLockKey(ns, userId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${key}::bigint)`);
    return fn(tx);
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
