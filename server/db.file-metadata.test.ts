/**
 * Integration tests for `deleteFileMetadataReturningSize`.
 *
 * Pins the three-case contract of the new helper:
 *
 *   1. When a matching row exists it is deleted and its file_size_bytes is
 *      returned — lets the caller decrement disk_usage_bytes atomically.
 *   2. When no row matches (missing key or wrong owner_id) the function
 *      returns deleted=false and fileSizeBytes=null — idempotent, no throw.
 *   3. An owner_id mismatch never deletes another user's row — defence-in-depth
 *      even though (s3_bucket, s3_key) is UNIQUE.
 *
 * Real Postgres only — DELETE … RETURNING is PG-specific. Set DATABASE_URL
 * (CI does this) to run; the suite skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { deleteFileMetadataReturningSize } from './db/queries/events.js';
import { __setPoolForTest } from './db/index.js';
import { story } from './testing/story.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL =
  process.env.FILE_METADATA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('deleteFileMetadataReturningSize', () => {
  const SCHEMA = `clipnest_file_metadata_delete_test_${Date.now()}`;
  let admin: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    admin = new pg.Pool({
      connectionString: TEST_URL!,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    // Auth-handshake retry — a cold CI runner can pass pg_isready (TCP layer)
    // seconds before auth backends attach.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        client = await admin.connect();
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
    if (lastErr) throw lastErr;

    await client!.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public`);

    // Minimal schema — only columns used by deleteFileMetadataReturningSize.
    // Plans table required by users FK; using minimal columns with defaults.
    await client.query(`
      CREATE TABLE plans (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Test',
        disk_space_bytes BIGINT NOT NULL DEFAULT 0,
        monthly_transfer_bytes BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`INSERT INTO plans (id, name) VALUES (1, 'Basic')`);

    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        uuid TEXT UNIQUE NOT NULL,
        email CITEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL DEFAULT 'x',
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        plan_id INTEGER REFERENCES plans(id),
        disk_usage_bytes BIGINT NOT NULL DEFAULT 0,
        transfer_usage_bytes BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        active BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);

    await client.query(`
      CREATE TABLE file_metadata (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        s3_bucket TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (s3_bucket, s3_key)
      )
    `);

    // Redirect the module-level pool to our scoped pool so the function
    // under test resolves tables against our schema.
    __setPoolForTest(admin);
    admin.on('connect', c => {
      c.query(`SET search_path TO "${SCHEMA}", public`).catch(() => { /* ignore */ });
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
      } catch { /* ignore — pool may already be closed */ }
      client.release();
    }
    if (admin) await admin.end();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await client.query('TRUNCATE file_metadata, users RESTART IDENTITY CASCADE');
  });

  /** Helper: insert a user and return their integer id. */
  async function seedUser(suffix: string): Promise<number> {
    const r = await client.query(
      `INSERT INTO users (uuid, email, plan_id) VALUES ($1, $2, 1) RETURNING id`,
      [`test-uuid-${suffix}`, `${suffix}@test.example`],
    );
    return r.rows[0].id as number;
  }

  /** Helper: insert a file_metadata row for a user. */
  async function seedFile(
    ownerId: number,
    s3Key: string,
    fileSizeBytes: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes)
       VALUES ($1, 'recordings', $2, $3, $4)`,
      [ownerId, s3Key, s3Key.split('/').pop(), fileSizeBytes],
    );
  }

  it('deletes the row and returns its file_size_bytes', async (ctx) => {
    story(ctx, 'Helper kasuje wiersz file_metadata i zwraca rozmiar pliku — pozwala wywołującemu zdekrementować disk_usage_bytes atomowo z DELETE.');
    const ownerId = await seedUser('del');
    await seedFile(ownerId, 'test/k1.mp4', 12345);

    const result = await deleteFileMetadataReturningSize(ownerId, 'recordings', 'test/k1.mp4');

    expect(result).toEqual({ deleted: true, fileSizeBytes: 12345 });
    const after = await client.query(
      `SELECT 1 FROM file_metadata WHERE s3_key = 'test/k1.mp4'`,
    );
    expect(after.rowCount).toBe(0);
  });

  it('returns deleted=false when row does not exist', async (ctx) => {
    story(ctx, 'Idempotency: drugi call helpera lub call dla nieistniejącego wiersza nie crashuje — zwraca deleted=false.');
    const result = await deleteFileMetadataReturningSize(99999, 'recordings', 'test/nope.mp4');
    expect(result).toEqual({ deleted: false, fileSizeBytes: null });
  });

  it('owner_id mismatch does not delete other users rows', async (ctx) => {
    story(ctx, 'Defense-in-depth: jeśli wywołujący poda zły owner_id, helper nie skasuje wiersza innego usera.');
    const realOwnerId = await seedUser('iso');
    await seedFile(realOwnerId, 'test/iso.mp4', 999);

    const result = await deleteFileMetadataReturningSize(99999, 'recordings', 'test/iso.mp4');
    expect(result).toEqual({ deleted: false, fileSizeBytes: null });

    const stillThere = await client.query(
      `SELECT 1 FROM file_metadata WHERE s3_key = 'test/iso.mp4'`,
    );
    expect(stillThere.rowCount).toBe(1);
  });
});
