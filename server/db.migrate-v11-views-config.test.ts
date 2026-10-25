/**
 * Migration regression test: v10 → v11 per-view icon personalization.
 *
 * Verifies that the Drizzle migration (0001_add_views_config.sql):
 *   1. Adds the `views_config` JSONB column to `user_camera_profiles`.
 *   2. Backfills every pre-feature row (a single {id: lens_default,
 *      iconKind:'generic'} entry) from the legacy `lens_default` column.
 *
 * Uses the same `migrateToSchema` helper as `db.migrate.test.ts` so both
 * migration files are applied together, matching production behaviour.
 *
 * Real Postgres only — set `DATABASE_URL_TEST` or `DATABASE_URL`; otherwise skips.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { dropScratchSchema, resetScratchSchema, migrateToSchema } from './testing/migrate-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');

const SCRATCH_SCHEMA = `test_v11_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!TEST_DB_URL)('drizzle migrate v11: user_camera_profiles.views_config', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 2,
      options: `-c search_path="${SCRATCH_SCHEMA}",public`,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    const cleanup = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await dropScratchSchema(cleanup, SCRATCH_SCHEMA);
    await cleanup.end();
  }, 60_000);

  beforeEach(async () => {
    await resetScratchSchema(pool, SCRATCH_SCHEMA);
  });

  it('adds views_config column after applying all migrations', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'user_camera_profiles'`,
      [SCRATCH_SCHEMA],
    );
    const cols = new Set(rows.map((r) => r.column_name));
    expect(cols.has('views_config')).toBe(true);
  });

  it('backfills views_config from lens_default for existing rows', { timeout: 60_000 }, async () => {
    // Apply only the baseline migration (without views_config), seed a legacy row,
    // then apply the full migrations including 0001_add_views_config to test backfill.
    //
    // We simulate the upgrade by: applying baseline only, inserting a legacy row,
    // then applying 0001 on top.

    // Step 1: apply baseline_v10 only
    const { readFileSync } = await import('node:fs');
    const baselineSql = readFileSync(
      join(MIGRATIONS_DIR, '0000_baseline_v10.sql'),
      'utf8',
    ).replace(/"public"\./g, `"${SCRATCH_SCHEMA}".`);

    // Split on drizzle breakpoints
    const statements = baselineSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pool.query(stmt);
    }

    // Step 2: seed a user + legacy camera profile row (no views_config column yet)
    await pool.query(
      `INSERT INTO "${SCRATCH_SCHEMA}".users (uuid, email, password_hash)
         VALUES ('u-v11', 'v11@test.com', 'x')`,
    );
    const userRow = await pool.query<{ id: number }>(
      `SELECT id FROM "${SCRATCH_SCHEMA}".users WHERE uuid = 'u-v11'`,
    );
    const userId = userRow.rows[0].id;

    await pool.query(
      `INSERT INTO "${SCRATCH_SCHEMA}".user_camera_profiles
           (user_id, name, regex, lens_default, priority)
         VALUES ($1, 'Legacy Cam', '^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$', 'legacy01', 5)`,
      [userId],
    );

    // Step 3: apply 0001_add_views_config.sql (the v11 migration)
    const v11Sql = readFileSync(
      join(MIGRATIONS_DIR, '0001_add_views_config.sql'),
      'utf8',
    ).replace(/"public"\./g, `"${SCRATCH_SCHEMA}".`);

    const v11Statements = v11Sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of v11Statements) {
      await pool.query(stmt);
    }

    // Step 4: verify the legacy row was backfilled
    const { rows } = await pool.query<{ views_config: unknown }>(
      `SELECT views_config FROM "${SCRATCH_SCHEMA}".user_camera_profiles WHERE name = 'Legacy Cam'`,
    );
    expect(rows[0].views_config).toEqual([{ id: 'legacy01', iconKind: 'generic' }]);
  });

  it('is idempotent: views_config default stays after double migration', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    // Running twice should not fail (idempotent via IF NOT EXISTS + WHERE guard)
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${SCRATCH_SCHEMA}".__drizzle_migrations`,
    );
    // One row per migration in the journal; bump when a migration is added
    // (0003_add_upload_30d_bytes took this from 3 → 4;
    //  0004_add_push_tables took this from 4 → 5;
    //  0005_add_push_supports_loc_keys took this from 5 → 6;
    //  0006_add_events_created_at took this from 6 → 7;
    //  0007_identities_framerate took this from 7 → 8;
    //  0008_add_processing_state took this from 8 → 9;
    //  0009_drop_legacy_playback_patch took this from 9 → 10;
    //  0010_unrecognized_retry_index took this from 10 → 11;
    //  0011_add_tv_device_codes took this from 11 → 12;
    //  0012_add_tv_device_id took this from 12 → 13;
    //  0013_oauth_token_generation took this from 13 → 14;
    //  0014_add_ip_login_throttle took this from 14 → 15;
    //  0015_add_file_metadata_truncated took this from 15 → 16;
    //  0016_add_invite_codes took this from 16 → 17;
    //  0017_add_push_device_relay took this from 17 → 18;
    //  0018_split_login_lockout_channels took this from 18 → 19).
    expect(parseInt(rows[0].count, 10)).toBe(27); // 26->27 when 0026_purchase_statements was added
  });
});
