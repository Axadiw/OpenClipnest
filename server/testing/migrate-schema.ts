/**
 * migrateToSchema — apply Drizzle migrations to an isolated scratch schema.
 *
 * Drizzle-generated migration SQL hard-codes `REFERENCES "public".<table>` in
 * every FK constraint.  When running tests against a scratch schema (instead
 * of a scratch database), these FK references point at the wrong schema, causing
 * `insert … violates foreign key constraint` errors.
 *
 * This helper reads the raw migration SQL files, replaces every `"public".`
 * occurrence with the target schema name, and executes the statements directly
 * on the pool — bypassing the drizzle migrator for the DDL step.  It also
 * creates the `__drizzle_migrations` tracking table in the scratch schema so
 * the behaviour is compatible with `migrationsSchema: SCRATCH_SCHEMA` used
 * in regular drizzleMigrate calls.
 *
 * Usage:
 *   import { migrateToSchema } from '../testing/migrate-schema.js';
 *   await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

interface Journal {
  entries: JournalEntry[];
}

export async function migrateToSchema(
  pool: Pool,
  schema: string,
  migrationsDir: string,
): Promise<void> {
  // Create the migrations tracking table in the scratch schema (mirrors
  // what drizzle's migrator does when migrationsSchema is set).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}".__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // Read the journal to get ordered migration entries + hashes
  const journal: Journal = JSON.parse(
    readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  );

  // Read snapshot hashes from meta directory for hash lookup
  const metaDir = join(migrationsDir, 'meta');
  const snapshotFiles = readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'));
  const snapshotHashes = new Map<string, string>();
  for (const snapshotFile of snapshotFiles) {
    const idx = snapshotFile.replace('_snapshot.json', '').padStart(4, '0');
    const snap = JSON.parse(readFileSync(join(metaDir, snapshotFile), 'utf8'));
    // Journal tag format: 0000_basename — look up by idx
    snapshotHashes.set(idx, snap.id ?? snap.hash ?? '');
  }

  for (const entry of journal.entries) {
    // Skip already-applied migrations (idempotency support)
    const existing = await pool.query(
      `SELECT 1 FROM "${schema}".__drizzle_migrations WHERE hash = $1`,
      [entry.tag],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      continue;
    }

    const sqlFile = join(migrationsDir, `${entry.tag}.sql`);
    const rawSql = readFileSync(sqlFile, 'utf8');

    // Replace every hard-coded "public".<table> FK reference with our schema.
    // This is necessary because Drizzle-kit always emits REFERENCES "public".<table>
    // regardless of where the tables actually live.
    const patchedSql = rawSql.replace(/"public"\./g, `"${schema}".`);

    // Split on breakpoints (Drizzle's statement separator)
    const statements = entry.breakpoints
      ? patchedSql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
      : [patchedSql];

    for (const stmt of statements) {
      await pool.query(stmt);
    }

    // Record migration in tracking table (use tag as hash — sufficient for test isolation)
    await pool.query(
      `INSERT INTO "${schema}".__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [entry.tag, entry.when],
    );
  }
}
