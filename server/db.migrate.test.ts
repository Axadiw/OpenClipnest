// server/db.migrate.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { migrateToSchema } from './testing/migrate-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');

const SCRATCH_SCHEMA = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!TEST_DB_URL)('drizzle migrate', () => {
  let pool: Pool;

  beforeAll(async () => {
    // options sets search_path at connection startup — no connect-event handler needed.
    pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path="${SCRATCH_SCHEMA}",public` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    // Cleanup via a separate one-shot connection (pool's connect handler
    // would still try to SET search_path to a dropped schema otherwise).
    const cleanup = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await cleanup.end();
  });

  beforeEach(async () => {
    // Wipe scratch schema for fresh state per test
    await pool.query(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCRATCH_SCHEMA}"`);
  });

  // 30s timeout: migrateToSchema applies all migration .sql files with
  // schema-name string-replacement; on CI's Postgres 14 each run takes
  // ~3-5s and vitest's default 5s timeout is too tight, especially when
  // several test files run migrate in parallel and contend for the pool.
  it('creates all 30 tables (24 v10 baseline + push + identities + tv_device_codes + ip_login_attempts + invite_codes) from baseline migration on empty DB', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename != '__drizzle_migrations' ORDER BY tablename`,
      [SCRATCH_SCHEMA],
    );
    const tables = rows.map((r) => r.tablename);

    // v10 adds event_view_files (24); 0004_add_push_tables adds
    // push_devices + push_prefs (26 total); 0007_identities_framerate adds
    // user_identities (27 total); 0011_add_tv_device_codes adds
    // tv_device_codes (28 total); 0014_add_ip_login_throttle adds
    // ip_login_attempts (29 total); 0016_add_invite_codes adds
    // invite_codes (30 total)
    expect(tables).toHaveLength(30);
    expect(tables).toEqual(expect.arrayContaining([
      'plans', 'users', 'email_tokens', 'passkeys', 'passkey_backup_codes',
      'events', 'event_view_files', 'file_metadata', 'user_scan_state', 'user_camera_profiles',
      'oauth_clients', 'oauth_authorization_txns', 'oauth_authorization_codes',
      'oauth_access_tokens', 'oauth_refresh_tokens',
      'upload_events', 'storage_reconciliation_runs', 'storage_disk_corrections',
      'storage_orphan_objects',
      'notifications', 'user_bans', 'user_appeals', 'mcp_audit_log', 'settings',
      'push_devices', 'push_prefs', 'user_identities', 'tv_device_codes',
      'ip_login_attempts', 'invite_codes',
    ]));
  });

  it('is idempotent on second run', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    // Count should equal the number of migration files in the journal.
    // Updated 2->3 when migration 0002_rename_lens_to_view was added;
    // 3->4 when migration 0003_add_upload_30d_bytes was added;
    // 4->5 when migration 0004_add_push_tables was added;
    // 5->6 when migration 0005_add_push_supports_loc_keys was added;
    // 6->7 when migration 0006_add_events_created_at was added;
    // 7->8 when migration 0007_identities_framerate was added;
    // 8->9 when migration 0008_add_processing_state was added;
    // 9->10 when migration 0009_drop_legacy_playback_patch was added;
    // 10->11 when migration 0010_unrecognized_retry_index was added;
    // 11->12 when migration 0011_add_tv_device_codes was added;
    // 12->13 when migration 0012_add_tv_device_id was added;
    // 13->14 when migration 0013_oauth_token_generation was added;
    // 14->15 when migration 0014_add_ip_login_throttle was added;
    // 15->16 when migration 0015_add_file_metadata_truncated was added;
    // 16->17 when migration 0016_add_invite_codes was added;
    // 17->18 when migration 0017_add_push_device_relay was added;
    // 18->19 when migration 0018_split_login_lockout_channels was added.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${SCRATCH_SCHEMA}".__drizzle_migrations`,
    );
    expect(parseInt(rows[0].count, 10)).toBe(19);
  });

  it('preserves CITEXT and JSONB column types', { timeout: 60_000 }, async () => {
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows: emailCol } = await pool.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='email'`,
      [SCRATCH_SCHEMA],
    );
    expect(emailCol[0]?.udt_name).toBe('citext');

    const { rows: jsonbCol } = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='mcp_audit_log' AND column_name='details_json'`,
      [SCRATCH_SCHEMA],
    );
    expect(jsonbCol[0]?.data_type).toBe('jsonb');
  });
});
