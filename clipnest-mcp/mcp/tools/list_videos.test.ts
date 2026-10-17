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
import { listVideosImpl } from './list_videos.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_LV = `mcp_lv_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('list_videos tool', () => {
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
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_LV}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_LV}"`);
    parent.pathname = `/${SCRATCH_DB_LV}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `lv-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `lv-other-${Date.now()}@example.com`],
    );
    otherUserId = u2.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_LV}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    // CASCADE so event_view_files FK doesn't block the wipe.
    await pool.query(`TRUNCATE events CASCADE`);
  });

  async function seedEvent(opts: {
    id: string;
    owner: number;
    camera?: string;
    ts?: Date;
    wide?: string | null;
    zoom?: string | null;
  }) {
    const camera = opts.camera ?? 'Cam_01';
    const ts = opts.ts ?? new Date();
    const wide = opts.wide === undefined ? 'p/wide.mp4' : opts.wide;
    const zoom = opts.zoom === undefined ? null : opts.zoom;
    const tsIso = ts.toISOString();
    const dateStr = tsIso.slice(0, 10);
    await pool.query(
      `INSERT INTO events (id, owner_id, camera, timestamp, date, duration, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, $2, $3, $4, $5, 30, 'thumb', TRUE, FALSE)`,
      [opts.id, opts.owner, camera, tsIso, dateStr],
    );
    if (wide) {
      await pool.query(
        `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
        [opts.id, wide],
      );
    }
    if (zoom) {
      await pool.query(
        `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '01', $2)`,
        [opts.id, zoom],
      );
    }
  }

  it("returns the caller's events with the trimmed shape", async () => {
    await seedEvent({ id: 'e1', owner: userId, camera: 'Cam_01' });
    await seedEvent({ id: 'e2', owner: userId, camera: 'Cam_01', zoom: 'p/zoom.mp4' });
    const r = await listVideosImpl({ camera: ['Cam_01'], limit: 10 }, { userId, scope: 'videos:read' });
    expect(r.videos.length).toBe(2);
    const e1 = r.videos.find(v => v.id === 'e1');
    const e2 = r.videos.find(v => v.id === 'e2');
    expect(e1).toMatchObject({
      camera: 'Cam_01',
      timestamp: expect.any(String),
      durationSec: 30,
      viewIds: ['00'],
    });
    expect(e2?.viewIds).toEqual(['00', '01']);
  });

  it("does not see another user's events", async () => {
    await seedEvent({ id: 'mine', owner: userId });
    await seedEvent({ id: 'theirs', owner: otherUserId });
    const r = await listVideosImpl({}, { userId, scope: 'videos:read' });
    const ids = r.videos.map(v => v.id);
    expect(ids).toContain('mine');
    expect(ids).not.toContain('theirs');
  });

  it('respects limit and returns nextCursor when more results exist', async () => {
    for (let i = 0; i < 4; i++) {
      await seedEvent({ id: `lim${i}`, owner: userId, ts: new Date(Date.now() - i * 60_000) });
    }
    const r = await listVideosImpl({ limit: 2 }, { userId, scope: 'videos:read' });
    expect(r.videos.length).toBe(2);
    expect(r.nextCursor).toBeDefined();
  });

  it('cursor round-trip: first page nextCursor returns second page', async () => {
    for (let i = 0; i < 4; i++) {
      await seedEvent({ id: `pg${i}`, owner: userId, ts: new Date(Date.now() - i * 60_000) });
    }
    const page1 = await listVideosImpl({ limit: 2 }, { userId, scope: 'videos:read' });
    const page2 = await listVideosImpl({ limit: 2, cursor: page1.nextCursor }, { userId, scope: 'videos:read' });
    const idsP1 = page1.videos.map(v => v.id);
    const idsP2 = page2.videos.map(v => v.id);
    expect(idsP1.length).toBe(2);
    expect(idsP2.length).toBeGreaterThan(0);
    // No id overlap
    expect(idsP1.filter(id => idsP2.includes(id))).toEqual([]);
  });

  it('throws insufficient_scope when scope lacks videos:read', async () => {
    await expect(listVideosImpl({}, { userId, scope: 'videos:delete' })).rejects.toThrow(/insufficient_scope/);
  });

  it('throws invalid_cursor for malformed cursor', async () => {
    await expect(listVideosImpl({ cursor: 'not-base64-json' }, { userId, scope: 'videos:read' })).rejects.toThrow(/invalid_cursor/);
  });

  it('clamps oversize limit to 100', async () => {
    await seedEvent({ id: 'one', owner: userId });
    const r = await listVideosImpl({ limit: 99999 }, { userId, scope: 'videos:read' });
    expect(r.videos.length).toBeGreaterThanOrEqual(1);
  });
});
