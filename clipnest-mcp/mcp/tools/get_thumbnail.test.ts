import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../../../server/db/index.js';
import { __setJwtSecretForTest } from '../../../server/db/queries/settings.js';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __mcp_dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__mcp_dirname, '..', '..', '..', 'server', 'db', 'migrations');
import { getThumbnailImpl } from './get_thumbnail.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_GT = `mcp_gt_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// NOTE: the S3 happy path (base64 + dimensions + signed URL) is not exercised
// here because the scratch test harness has no S3/SSE-C backend — every
// assertion below short-circuits BEFORE the S3 fetch (scope, owner lookup,
// missing/tombstoned thumbnail). The S3 round-trip is covered by the existing
// server-side thumbnail-route tests and the live QA pass.
describeIfDb('get_thumbnail tool', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let otherUserId: number;

  const auth = (uid: number, scope = 'videos:read') => ({
    userId: uid, clientId: 'test-client', scope, familyId: 'fam', resource: 'res',
  });

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GT}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_GT}"`);
    parent.pathname = `/${SCRATCH_DB_GT}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    __setJwtSecretForTest('test-jwt-secret-for-unit-tests');
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id, encryption_salt)
       VALUES ($1, $2, 'x', true, true, 1, 'salt') RETURNING id`,
      [randomUUID(), `gt-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id, encryption_salt)
       VALUES ($1, $2, 'x', true, true, 1, 'salt') RETURNING id`,
      [randomUUID(), `gt-other-${Date.now()}@example.com`],
    );
    otherUserId = u2.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GT}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE events CASCADE`);
  });

  async function seedEvent(opts: { id: string; owner: number; thumbnail: string | null }) {
    const ts = new Date().toISOString();
    const dateStr = ts.slice(0, 10);
    await pool.query(
      `INSERT INTO events (id, owner_id, camera, timestamp, date, duration, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, $2, 'Cam', $3, $4, 30, $5, TRUE, FALSE)`,
      [opts.id, opts.owner, ts, dateStr, opts.thumbnail],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
      [opts.id, `p/${opts.id}.mp4`],
    );
  }

  it('throws insufficient_scope without videos:read', async () => {
    await seedEvent({ id: 'scope', owner: userId, thumbnail: 'p/thumb.jpg' });
    await expect(getThumbnailImpl({ id: 'scope' }, auth(userId, 'account:read'))).rejects.toThrow(/insufficient_scope/);
  });

  it("throws not_found when the event belongs to another user (owner isolation)", async () => {
    await seedEvent({ id: 'theirs', owner: otherUserId, thumbnail: 'p/thumb.jpg' });
    await expect(getThumbnailImpl({ id: 'theirs' }, auth(userId))).rejects.toThrow(/not_found/);
  });

  it('throws not_found for a non-existent event', async () => {
    await expect(getThumbnailImpl({ id: 'nope' }, auth(userId))).rejects.toThrow(/not_found/);
  });

  it('throws thumbnail_not_found when the event has no thumbnail', async () => {
    await seedEvent({ id: 'no-thumb', owner: userId, thumbnail: null });
    await expect(getThumbnailImpl({ id: 'no-thumb' }, auth(userId))).rejects.toThrow(/thumbnail_not_found/);
  });

  it('throws thumbnail_not_found for the unplayable tombstone', async () => {
    await seedEvent({ id: 'tomb', owner: userId, thumbnail: '__unplayable__' });
    await expect(getThumbnailImpl({ id: 'tomb' }, auth(userId))).rejects.toThrow(/thumbnail_not_found/);
  });
});
