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
import { listCamerasImpl } from './list_cameras.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_LC = `mcp_lc_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const auth = (userId: number, scope = 'account:read') => ({
  userId, clientId: 'test-client', scope, familyId: 'fam', resource: 'res',
});

describeIfDb('list_cameras tool', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let otherUserId: number;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_LC}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_LC}"`);
    parent.pathname = `/${SCRATCH_DB_LC}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `lc-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `lc-other-${Date.now()}@example.com`],
    );
    otherUserId = u2.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_LC}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE events CASCADE`);
  });

  async function seedEvent(opts: { id: string; owner: number; camera: string; ts?: Date }) {
    const ts = (opts.ts ?? new Date()).toISOString();
    const dateStr = ts.slice(0, 10);
    await pool.query(
      `INSERT INTO events (id, owner_id, camera, timestamp, date, duration, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, $2, $3, $4, $5, 30, 'thumb', TRUE, FALSE)`,
      [opts.id, opts.owner, opts.camera, ts, dateStr],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
      [opts.id, `p/${opts.id}.mp4`],
    );
  }

  it('returns per-camera inventory with clip count and last/first recording time', async () => {
    const older = new Date(Date.now() - 3600_000);
    const newer = new Date();
    await seedEvent({ id: 'a1', owner: userId, camera: 'Front', ts: older });
    await seedEvent({ id: 'a2', owner: userId, camera: 'Front', ts: newer });
    await seedEvent({ id: 'b1', owner: userId, camera: 'Back', ts: newer });

    const r = await listCamerasImpl({}, auth(userId));
    const front = r.cameras.find(c => c.name === 'Front');
    const back = r.cameras.find(c => c.name === 'Back');
    expect(front?.clipCount).toBe(2);
    expect(back?.clipCount).toBe(1);
    expect(new Date(front!.lastRecordingAt).getTime()).toBeGreaterThanOrEqual(new Date(front!.firstRecordingAt).getTime());
  });

  it("does not see another user's cameras", async () => {
    await seedEvent({ id: 'mine', owner: userId, camera: 'Mine' });
    await seedEvent({ id: 'theirs', owner: otherUserId, camera: 'Theirs' });
    const r = await listCamerasImpl({}, auth(userId));
    const names = r.cameras.map(c => c.name);
    expect(names).toContain('Mine');
    expect(names).not.toContain('Theirs');
  });

  it('throws insufficient_scope without account:read', async () => {
    await expect(listCamerasImpl({}, auth(userId, 'videos:read'))).rejects.toThrow(/insufficient_scope/);
  });
});
