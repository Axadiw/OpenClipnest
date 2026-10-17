import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../../../server/db/index.js';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __mcp_dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__mcp_dirname, '..', '..', '..', 'server', 'db', 'migrations');
import { getStatsImpl } from './get_stats.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_GS = `mcp_gs_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const auth = (userId: number, scope = 'account:read') => ({
  userId, clientId: 'test-client', scope, familyId: 'fam', resource: 'res',
});

describeIfDb('get_stats tool', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let userUuid: string;
  let otherUserId: number;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GS}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_GS}"`);
    parent.pathname = `/${SCRATCH_DB_GS}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    userUuid = randomUUID();
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [userUuid, `gs-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `gs-other-${Date.now()}@example.com`],
    );
    otherUserId = u2.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GS}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE events CASCADE`);
    await pool.query(`DELETE FROM file_metadata`);
  });

  // Seed an event + its view file + a matching file_metadata row so the
  // per-camera byte sum (getDiskUsageByCamera) has a size to attribute.
  async function seedEvent(opts: {
    id: string; owner: number; ownerUuid: string; camera: string; ts: Date; sizeBytes: number;
  }) {
    const ts = opts.ts.toISOString();
    const dateStr = ts.slice(0, 10);
    const rel = `p/${opts.id}.mp4`;
    await pool.query(
      `INSERT INTO events (id, owner_id, camera, timestamp, date, duration, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, $2, $3, $4, $5, 30, 'thumb', TRUE, FALSE)`,
      [opts.id, opts.owner, opts.camera, ts, dateStr],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
      [opts.id, rel],
    );
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state)
       VALUES ($1, 'recordings', $2, $3, $4, 'ready')`,
      [opts.owner, `${opts.ownerUuid}/${rel}`, `${opts.id}.mp4`, opts.sizeBytes],
    );
  }

  it('aggregates per-camera counts, storage, duration, and overall date range', async () => {
    const early = new Date('2026-01-01T10:00:00Z');
    const late = new Date('2026-03-15T20:00:00Z');
    await seedEvent({ id: 's1', owner: userId, ownerUuid: userUuid, camera: 'Front', ts: early, sizeBytes: 100 });
    await seedEvent({ id: 's2', owner: userId, ownerUuid: userUuid, camera: 'Front', ts: late, sizeBytes: 200 });
    await seedEvent({ id: 's3', owner: userId, ownerUuid: userUuid, camera: 'Back', ts: late, sizeBytes: 50 });

    const r = await getStatsImpl({}, auth(userId));
    expect(r.totalClips).toBe(3);
    expect(r.totalStorageBytes).toBe(350);
    expect(r.dateRange.from).toBe(early.toISOString());
    expect(r.dateRange.to).toBe(late.toISOString());

    const front = r.perCamera.find(c => c.name === 'Front');
    expect(front?.clipCount).toBe(2);
    expect(front?.storageBytes).toBe(300);
    expect(front?.durationSeconds).toBe(60);
  });

  it("does not include another user's data", async () => {
    await seedEvent({ id: 'mine', owner: userId, ownerUuid: userUuid, camera: 'Mine', ts: new Date(), sizeBytes: 10 });
    await seedEvent({ id: 'theirs', owner: otherUserId, ownerUuid: randomUUID(), camera: 'Theirs', ts: new Date(), sizeBytes: 999 });
    const r = await getStatsImpl({}, auth(userId));
    expect(r.totalClips).toBe(1);
    expect(r.perCamera.map(c => c.name)).not.toContain('Theirs');
  });

  it('throws insufficient_scope without account:read', async () => {
    await expect(getStatsImpl({}, auth(userId, 'videos:read'))).rejects.toThrow(/insufficient_scope/);
  });
});
