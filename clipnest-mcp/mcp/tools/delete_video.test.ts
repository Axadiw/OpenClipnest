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
import { createClient } from '../../db/queries.js';
import { deleteVideoImpl } from './delete_video.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_DV = `mcp_dv_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('delete_video tool', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let testClientId: string;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_DV}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_DV}"`);
    parent.pathname = `/${SCRATCH_DB_DV}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    __setJwtSecretForTest('test-jwt-secret-for-unit-tests');
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `dv-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    // Seed a real oauth_client so audit log FK constraint is satisfied
    testClientId = await createClient({
      clientName: 'delete-video-test-client',
      redirectUris: ['http://localhost/cb'],
      createdByUserId: userId,
    });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_DV}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    // CASCADE so event_view_files FK doesn't block the wipe.
    await pool.query(`TRUNCATE events CASCADE`);
    await pool.query(`DELETE FROM mcp_audit_log`);
  });

  async function seedEvent(opts: {
    id: string;
    owner: number;
    camera?: string;
    wide?: string | null;
    zoom?: string | null;
  }) {
    const camera = opts.camera ?? 'Cam_01';
    const ts = new Date().toISOString();
    const dateStr = ts.slice(0, 10);
    const wide = opts.wide === undefined ? 'p/wide.mp4' : opts.wide;
    const zoom = opts.zoom === undefined ? null : opts.zoom;
    await pool.query(
      `INSERT INTO events (id, owner_id, camera, timestamp, date, duration, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, $2, $3, $4, $5, 30, 'thumb', TRUE, FALSE)`,
      [opts.id, opts.owner, camera, ts, dateStr],
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

  it('deletes the event when confirm=true and verifies via subsequent SELECT', async () => {
    await seedEvent({ id: 'del-test', owner: userId });
    const r = await deleteVideoImpl(
      { id: 'del-test', confirm: true },
      { userId, clientId: testClientId, scope: 'videos:delete', familyId: 'fam', resource: 'res' },
    );
    expect(r).toEqual({ deleted: true, id: 'del-test' });
    const check = await pool.query(`SELECT id FROM events WHERE id = 'del-test'`);
    expect(check.rowCount).toBe(0);
  });

  it('requires confirm to be literally true (false throws)', async () => {
    await seedEvent({ id: 'no-confirm', owner: userId });
    await expect(
      deleteVideoImpl(
        { id: 'no-confirm', confirm: false },
        { userId, clientId: testClientId, scope: 'videos:delete', familyId: 'fam', resource: 'res' },
      ),
    ).rejects.toThrow(/confirm:true required/);
  });

  it('requires confirm to be literally true (missing confirm throws)', async () => {
    await seedEvent({ id: 'missing-confirm', owner: userId });
    await expect(
      deleteVideoImpl(
        { id: 'missing-confirm', confirm: undefined as unknown as boolean },
        { userId, clientId: testClientId, scope: 'videos:delete', familyId: 'fam', resource: 'res' },
      ),
    ).rejects.toThrow(/confirm:true required/);
  });

  it('throws insufficient_scope without videos:delete', async () => {
    await seedEvent({ id: 'scope-test', owner: userId });
    await expect(
      deleteVideoImpl(
        { id: 'scope-test', confirm: true },
        { userId, clientId: testClientId, scope: 'videos:read', familyId: 'fam', resource: 'res' },
      ),
    ).rejects.toThrow(/insufficient_scope/);
  });

  it('writes mcp_audit_log entry with action=tool.delete_video and details_json.event_id', async () => {
    await seedEvent({ id: 'audit-test', owner: userId });
    await deleteVideoImpl(
      { id: 'audit-test', confirm: true },
      { userId, clientId: testClientId, scope: 'videos:delete', familyId: 'fam', resource: 'res' },
    );
    const log = await pool.query(
      `SELECT action, details_json, client_id FROM mcp_audit_log WHERE action = 'tool.delete_video' LIMIT 1`,
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].action).toBe('tool.delete_video');
    expect(log.rows[0].details_json.event_id).toBe('audit-test');
    expect(log.rows[0].client_id).toBe(testClientId);
  });
});
