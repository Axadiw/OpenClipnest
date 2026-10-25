/**
 * Migration regression test: 0018_split_login_lockout_channels.
 *
 * Upgrades a database that already holds an account and lockouts written by
 * the previous release, and checks the migration is additive: existing rows
 * keep their values (the account its time zone, the lockout no channel — so it
 * keeps blocking both logins until it expires), new accounts default to UTC,
 * and the new columns and constraint behave.
 *
 * Real Postgres only — set `DATABASE_URL_TEST` or `DATABASE_URL`; otherwise skips.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropScratchSchema, migrateToSchema } from './testing/migrate-schema.js';
import { story } from './testing/story.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');
const TAG = '0018_split_login_lockout_channels';
const SCRATCH_SCHEMA = `test_0018_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!TEST_DB_URL)(`drizzle migrate ${TAG}`, () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path="${SCRATCH_SCHEMA}",public` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const cleanup = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await dropScratchSchema(cleanup, SCRATCH_SCHEMA);
    await cleanup.end();
  }, 60_000);

  it('is additive: existing accounts and lockouts keep their values, new accounts start on UTC', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Migracja tylko dodaje: istniejące konto zachowuje swoją strefę, a blokada zapisana przed nią nie dostaje kanału, więc dalej blokuje oba logowania do wygaśnięcia. Nowe konto startuje w UTC z zerowymi licznikami FTP.');
    // Everything up to the previous release: mark this migration as applied
    // so the helper skips it, then seed what that release would have written.
    await pool.query(`CREATE TABLE "${SCRATCH_SCHEMA}".__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    await pool.query(`INSERT INTO "${SCRATCH_SCHEMA}".__drizzle_migrations (hash, created_at) VALUES ($1, 0)`, [TAG]);
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const old = await pool.query<{ id: number; timezone: string }>(
      `INSERT INTO users (uuid, email, password_hash, failed_login_attempts, lockout_count)
       VALUES ('u-old', 'old@example.org', 'x', 3, 2) RETURNING id, timezone`,
    );
    expect(old.rows[0].timezone).toBe('Europe/Warsaw');
    const oldId = old.rows[0].id;
    await pool.query(`INSERT INTO user_bans (user_id, type, expires_at) VALUES ($1, 'lockout', NOW() + INTERVAL '1 hour')`, [oldId]);

    // Now the upgrade itself.
    await pool.query(`DELETE FROM "${SCRATCH_SCHEMA}".__drizzle_migrations WHERE hash = $1`, [TAG]);
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    const { rows: [kept] } = await pool.query(
      `SELECT timezone, failed_login_attempts, lockout_count, ftp_failed_login_attempts, ftp_lockout_count FROM users WHERE id = $1`,
      [oldId],
    );
    expect(kept).toEqual({
      timezone: 'Europe/Warsaw', failed_login_attempts: 3, lockout_count: 2, ftp_failed_login_attempts: 0, ftp_lockout_count: 0,
    });
    const { rows: [ban] } = await pool.query(`SELECT channel FROM user_bans WHERE user_id = $1`, [oldId]);
    expect(ban.channel).toBeNull();

    const { rows: [fresh] } = await pool.query(
      `INSERT INTO users (uuid, email, password_hash) VALUES ('u-new', 'new@example.org', 'x') RETURNING timezone, ftp_failed_login_attempts`,
    );
    expect(fresh).toEqual({ timezone: 'UTC', ftp_failed_login_attempts: 0 });
  });

  it('accepts only the web and ftp channels (or none)', { timeout: 60_000 }, async () => {
    const { rows: [u] } = await pool.query(`INSERT INTO users (uuid, email) VALUES ('u-ch', 'ch@example.org') RETURNING id`);
    for (const channel of ['web', 'ftp', null]) {
      await pool.query(`INSERT INTO user_bans (user_id, type, channel, expires_at) VALUES ($1, 'lockout', $2, NOW())`, [u.id, channel]);
    }
    await expect(
      pool.query(`INSERT INTO user_bans (user_id, type, channel, expires_at) VALUES ($1, 'lockout', 'sms', NOW())`, [u.id]),
    ).rejects.toThrow(/user_bans_channel_check/);
  });

  it('can be applied twice', { timeout: 60_000 }, async () => {
    await pool.query(`DELETE FROM "${SCRATCH_SCHEMA}".__drizzle_migrations WHERE hash = $1`, [TAG]);
    await expect(migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR)).resolves.toBeUndefined();
  });
});
