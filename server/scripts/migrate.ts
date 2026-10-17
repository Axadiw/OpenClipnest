#!/usr/bin/env node
/**
 * Production migration entry point. Run once per release by a dedicated
 * k8s Job before pod image bump (pods boot with RUN_MIGRATE_AT_STARTUP=false).
 *
 * Calls drizzle-orm/node-postgres/migrator which:
 *   - Creates drizzle.__drizzle_migrations table if missing
 *   - Reads server/db/migrations/*.sql + meta/_journal.json
 *   - Applies any migrations whose hash is not in __drizzle_migrations
 *   - On an already-stamped DB the baseline_v10 row is already present in
 *     __drizzle_migrations, so the baseline is skipped
 *
 * Safety: refuses to run if the public schema has tables but
 * __drizzle_migrations is empty — an unstamped pre-Drizzle (v9) DB. Post-
 * cutover this should not happen against the real prod DB; if it fires you
 * are almost certainly pointed at the wrong database.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrlFromEnv } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  // A full URL is used as is; a bare host:port/db gets POSTGRES_USER /
  // POSTGRES_PASSWORD, percent-encoded — the same URL every other process builds.
  const dbUrl = databaseUrlFromEnv();

  // `lock_timeout` caps how long any statement waits to ACQUIRE a lock before
  // erroring with 55P03. DDL like `ALTER TABLE … RENAME` needs ACCESS EXCLUSIVE,
  // which queues behind the still-running (pre-roll) pods' queries on hot tables
  // — without a timeout the migrator hangs until the migration job's wait
  // gives up (the v0.10.352 lens→view rename hung 180s × 3 exactly this way).
  // 3s lets a RENAME slip into a gap in traffic; if it can't, we fail fast and
  // retry below rather than block the whole table's lock queue indefinitely.
  // `statement_timeout=0` so a globally-configured statement timeout can't kill
  // a legitimately long migration once it HAS the lock.
  const pool = new Pool({
    connectionString: dbUrl,
    max: 1,
    options: '-c lock_timeout=3000 -c statement_timeout=0',
  });
  const db = drizzle(pool);

  try {
    // Safety net: refuse to migrate an existing schema that has not been stamped
    const { rows: tableCount } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_tables WHERE schemaname = 'public'`,
    );
    const publicTables = parseInt(tableCount[0]?.count ?? '0', 10);

    const { rows: stampRows } = await pool.query<{ hash: string }>(
      `SELECT hash FROM drizzle.__drizzle_migrations LIMIT 1`,
    ).catch(() => ({ rows: [] as { hash: string }[] }));

    if (publicTables > 0 && stampRows.length === 0) {
      throw new Error(
        `Refusing to migrate: found ${publicTables} tables in public schema but ` +
        `drizzle.__drizzle_migrations is empty. This is an unstamped pre-Drizzle (v9) ` +
        `schema. The prod DB was stamped during the Drizzle cutover, so this almost ` +
        `certainly means DATABASE_URL points at the wrong database. To re-stamp a ` +
        `legacy v9 DB, recover the baseline-stamp procedure from git history ` +
        `(server/scripts/drizzle-baseline-stamp.ts, removed post-cutover).`,
      );
    }

    // Retry the migrator to absorb ACCESS EXCLUSIVE lock contention and
    // deadlocks from the pods still serving traffic when this Job runs (migrate
    // happens BEFORE the image roll). drizzle-orm 0.45.2 wraps the WHOLE
    // pending batch in ONE transaction (PgDialect.migrate in
    // node_modules/drizzle-orm/pg-core/dialect.js), NOT one transaction per
    // file — a failed statement rolls back the entire batch and the next
    // attempt re-runs it from scratch. Bounded so the worst case (every attempt
    // waits the full lock_timeout) stays under the deploy job's 180s wait: 25 × (≤3s lock wait + 1.5s backoff) ≈ 112s.
    const MAX_ATTEMPTS = 25;
    const RETRY_DELAY_MS = 1500;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await migrate(db, { migrationsFolder: join(__dirname, '..', 'db', 'migrations') });
        console.log(`Migrations applied (attempt ${attempt}).`);
        break;
      } catch (err) {
        // drizzle wraps the driver error in a DrizzleQueryError, so the pg
        // 55P03 (lock_timeout) lives on err.cause, NOT err itself — check both
        // the code and the message on each layer or the retry never fires.
        const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
        const code = (err as { code?: string } | null)?.code ?? cause?.code;
        const msg = `${err instanceof Error ? err.message : String(err)} ${cause?.message ?? ''}`;
        const lockContention =
          code === '55P03' || code === '40P01' ||
          /lock[_ ]?timeout|canceling statement due to lock timeout/i.test(msg);
        if (!lockContention || attempt >= MAX_ATTEMPTS) throw err;
        console.warn(
          `Migration attempt ${attempt}/${MAX_ATTEMPTS} blocked acquiring a table lock ` +
          `(${code ?? 'lock_timeout'}); retrying in ${RETRY_DELAY_MS}ms…`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
