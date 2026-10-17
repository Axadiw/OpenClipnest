/**
 * Regression guard: the migration SQL must bake the
 * correct column defaults and drop dormant HLS columns from the start.
 *
 * Previously this test mocked `pg` and asserted that the legacy `migrate()`
 * body emitted specific ALTER TABLE statements at startup. After Task 19
 * replaced the inline DDL runner with drizzle-orm/node-postgres/migrator, the
 * fix is baked directly into the baseline migration SQL — so the test now
 * validates the migration file content instead.
 *
 * What we're guarding against:
 *   - Someone edits the migration and accidentally removes DEFAULT 0 from
 *     thumbnail_attempts or DEFAULT FALSE from playback_ready — which would
 *     cause NOT NULL constraint failures on INSERT without explicit values.
 *   - HLS columns creeping back into the schema (they were permanently removed
 *     and must stay gone).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, 'db', 'migrations', '0000_baseline_v10.sql');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf-8');

describe('baseline migration SQL: events table column defaults and HLS removal', () => {
  it('thumbnail_attempts has DEFAULT 0 in the events table', () => {
    // The column must have DEFAULT 0 so INSERTs without an explicit value don't
    // fail the NOT NULL constraint.
    expect(migrationSql).toMatch(/"thumbnail_attempts"\s+integer\s+DEFAULT\s+0\s+NOT NULL/i);
  });

  it('playback_ready has DEFAULT false in the events table', () => {
    // The column must have DEFAULT false so the thumbnail worker can insert
    // events before playback is confirmed without needing to pass an explicit
    // value.
    expect(migrationSql).toMatch(/"playback_ready"\s+boolean\s+DEFAULT\s+false\s+NOT NULL/i);
  });

  it('hls_ready column is absent from the events table (HLS removed)', () => {
    // hls_ready was dropped as part of the HLS removal. Its presence in the
    // schema would reintroduce a NOT NULL column without a DEFAULT, causing
    // INSERT failures on legacy code paths.
    expect(migrationSql).not.toMatch(/"hls_ready"/i);
  });

  it('hls_unplayable column is absent from the events table (HLS removed)', () => {
    expect(migrationSql).not.toMatch(/"hls_unplayable"/i);
  });
});
