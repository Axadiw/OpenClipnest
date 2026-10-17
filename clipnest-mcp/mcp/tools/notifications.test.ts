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
import { createClient } from '../../db/queries.js';
import { muteNotificationsImpl, getNotificationStatusImpl } from './notifications.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_NT = `mcp_nt_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('mute_notifications / get_notification_status tools', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let otherUserId: number;
  let testClientId: string;

  const auth = (uid: number, scope: string) => ({
    userId: uid, clientId: testClientId, scope, familyId: 'fam', resource: 'res',
  });

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_NT}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_NT}"`);
    parent.pathname = `/${SCRATCH_DB_NT}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u1 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `nt-test-${Date.now()}@example.com`],
    );
    userId = u1.rows[0].id;
    const u2 = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `nt-other-${Date.now()}@example.com`],
    );
    otherUserId = u2.rows[0].id;
    testClientId = await createClient({
      clientName: 'notifications-test-client',
      redirectUris: ['http://localhost/cb'],
      createdByUserId: userId,
    });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_NT}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM push_prefs`);
    await pool.query(`DELETE FROM mcp_audit_log`);
  });

  it('defaults to not muted when no push_prefs row exists', async () => {
    const r = await getNotificationStatusImpl({}, auth(userId, 'notifications:write'));
    expect(r).toEqual({ muted: false, snoozeUntil: null });
  });

  it('mutes until a given time and reads back the same window', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const muted = await muteNotificationsImpl({ mute: true, until }, auth(userId, 'notifications:write'));
    expect(muted.muted).toBe(true);
    expect(new Date(muted.snoozeUntil!).getTime()).toBe(new Date(until).getTime());

    const status = await getNotificationStatusImpl({}, auth(userId, 'notifications:write'));
    expect(status.muted).toBe(true);
  });

  it('mutes indefinitely when until is omitted (far-future sentinel)', async () => {
    const r = await muteNotificationsImpl({ mute: true }, auth(userId, 'notifications:write'));
    expect(r.muted).toBe(true);
    expect(new Date(r.snoozeUntil!).getFullYear()).toBeGreaterThan(9000);
  });

  it('unmutes (clears the window) on mute:false', async () => {
    await muteNotificationsImpl({ mute: true }, auth(userId, 'notifications:write'));
    const r = await muteNotificationsImpl({ mute: false }, auth(userId, 'notifications:write'));
    expect(r).toEqual({ muted: false, snoozeUntil: null });
    const status = await getNotificationStatusImpl({}, auth(userId, 'notifications:write'));
    expect(status.muted).toBe(false);
  });

  it('a past snooze window reads as not muted', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    await muteNotificationsImpl({ mute: true, until: past }, auth(userId, 'notifications:write'));
    const status = await getNotificationStatusImpl({}, auth(userId, 'notifications:write'));
    expect(status.muted).toBe(false);
    expect(status.snoozeUntil).toBeNull();
  });

  it('is owner-isolated: muting one user does not mute another', async () => {
    await muteNotificationsImpl({ mute: true }, auth(userId, 'notifications:write'));
    const other = await getNotificationStatusImpl({}, auth(otherUserId, 'notifications:write'));
    expect(other.muted).toBe(false);
  });

  it('rejects an invalid until string', async () => {
    await expect(
      muteNotificationsImpl({ mute: true, until: 'not-a-date' }, auth(userId, 'notifications:write')),
    ).rejects.toThrow(/until must be/);
  });

  it('throws insufficient_scope without notifications:write (both tools)', async () => {
    await expect(
      muteNotificationsImpl({ mute: true }, auth(userId, 'account:read')),
    ).rejects.toThrow(/insufficient_scope/);
    await expect(
      getNotificationStatusImpl({}, auth(userId, 'account:read')),
    ).rejects.toThrow(/insufficient_scope/);
  });

  it('writes an mcp_audit_log entry on mute', async () => {
    await muteNotificationsImpl({ mute: true }, auth(userId, 'notifications:write'));
    const log = await pool.query(
      `SELECT action, client_id FROM mcp_audit_log WHERE action = 'tool.mute_notifications' LIMIT 1`,
    );
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].client_id).toBe(testClientId);
  });
});
