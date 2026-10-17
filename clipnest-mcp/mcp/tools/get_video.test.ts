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
import { getVideoImpl } from './get_video.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_GV = `mcp_gv_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('get_video tool', () => {
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
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GV}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_GV}"`);
    parent.pathname = `/${SCRATCH_DB_GV}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    __setJwtSecretForTest('test-jwt-secret-for-unit-tests');
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    userUuid = randomUUID();
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [userUuid, `gv-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `gv-other-${Date.now()}@example.com`],
    );
    otherUserId = u2.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_GV}"`);
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

  it("returns metadata + both wide ('00') and zoom ('01') URLs for dual-view event", async () => {
    await seedEvent({ id: 'dual-view', owner: userId, camera: 'Cam_A', wide: 'p/wide.mp4', zoom: 'p/zoom.mp4' });
    const r = await getVideoImpl({ id: 'dual-view' }, { userId, clientId: 'test-client', scope: 'videos:read', familyId: 'fam', resource: 'res' });
    expect(r.id).toBe('dual-view');
    expect(r.camera).toBe('Cam_A');
    expect(r.durationSec).toBe(30);
    expect(r.timestamp).toEqual(expect.any(String));
    expect(r.downloads['00']).toBeDefined();
    expect(r.downloads['01']).toBeDefined();
    expect(r.downloads['00']!.url).toContain('?media_token=');
    expect(r.downloads['01']!.url).toContain('?media_token=');
    expect(r.downloads['00']!.expiresAt).toEqual(expect.any(String));
    expect(r.downloads['01']!.expiresAt).toEqual(expect.any(String));
  });

  it("returns only wide ('00') URL when zoom is null", async () => {
    await seedEvent({ id: 'wide-only', owner: userId, wide: 'p/wide.mp4', zoom: null });
    const r = await getVideoImpl({ id: 'wide-only' }, { userId, clientId: 'test-client', scope: 'videos:read', familyId: 'fam', resource: 'res' });
    expect(r.downloads['00']).toBeDefined();
    expect(r.downloads['01']).toBeUndefined();
  });

  it('throws not_found when event belongs to another user', async () => {
    await seedEvent({ id: 'other-event', owner: otherUserId });
    await expect(
      getVideoImpl({ id: 'other-event' }, { userId, clientId: 'test-client', scope: 'videos:read', familyId: 'fam', resource: 'res' }),
    ).rejects.toThrow(/not_found/);
  });

  it('throws insufficient_scope when scope is only videos:delete', async () => {
    await seedEvent({ id: 'scope-test', owner: userId });
    await expect(
      getVideoImpl({ id: 'scope-test' }, { userId, clientId: 'test-client', scope: 'videos:delete', familyId: 'fam', resource: 'res' }),
    ).rejects.toThrow(/insufficient_scope/);
  });

  it('URL contains ?media_token= and a valid-looking JWT-shaped string', async () => {
    await seedEvent({ id: 'jwt-shape', owner: userId, wide: 'p/wide.mp4', zoom: null });
    const r = await getVideoImpl({ id: 'jwt-shape' }, { userId, clientId: 'test-client', scope: 'videos:read', familyId: 'fam', resource: 'res' });
    const url = r.downloads['00']!.url;
    const tokenMatch = url.match(/\?media_token=(.+)$/);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];
    // A JWT has 3 base64url-encoded parts separated by dots
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });

  it('expiresAt is ~2 min from now (MCP-issued tokens use shortened TTL)', async () => {
    await seedEvent({ id: 'ttl-test', owner: userId, wide: 'p/wide.mp4', zoom: 'p/zoom.mp4' });
    const before = Date.now();
    const r = await getVideoImpl({ id: 'ttl-test' }, { userId, clientId: 'test-client', scope: 'videos:read', familyId: 'fam', resource: 'res' });
    const after = Date.now();

    const wideTtlMs = new Date(r.downloads['00']!.expiresAt).getTime() - before;
    const zoomTtlMs = new Date(r.downloads['01']!.expiresAt).getTime() - before;
    // Tolerance accounts for the small wall-clock gap between recording
    // `before` and the worker computing `expiresAt`. Anything that lands
    // in the [115s, 125s] window is unambiguously the 2-min TTL and not
    // the previous 15-min TTL (which would be ~900_000 ms).
    expect(wideTtlMs).toBeGreaterThanOrEqual(115_000);
    expect(wideTtlMs).toBeLessThanOrEqual(125_000 + (after - before));
    expect(zoomTtlMs).toBeGreaterThanOrEqual(115_000);
    expect(zoomTtlMs).toBeLessThanOrEqual(125_000 + (after - before));
    // Sanity floor — the 15-min TTL would put us at >=14*60s = 840_000 ms.
    expect(wideTtlMs).toBeLessThan(14 * 60_000);
    expect(zoomTtlMs).toBeLessThan(14 * 60_000);
  });
});
