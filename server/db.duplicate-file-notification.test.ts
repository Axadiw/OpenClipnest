/**
 * Integration tests for `upsertDuplicateFileNotification`.
 *
 * Pinned behaviour:
 *
 *   1. First call for an (user, eventId) → INSERT with hiddenPaths=[path].
 *   2. Second call with a NEW path for the same eventId → UPDATE: append to
 *      hiddenPaths array, refresh the message, reset read_at to NULL so the
 *      bell badge re-lights even if the user marked the previous version read.
 *   3. Second call with a PATH ALREADY IN hiddenPaths → no-op: details, message,
 *      read_at unchanged. This is the dedupe guard against scanner re-runs.
 *   4. Different eventIds for the same user → separate rows.
 *
 * Skips silently when DATABASE_URL is unset (CI sets it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { upsertDuplicateFileNotification } from './db/queries/notifications.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.DUPLICATE_NOTIFICATION_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('upsertDuplicateFileNotification', () => {
  const SCHEMA = `clipnest_dup_notif_test_${Date.now()}`;
  let admin: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    admin = new pg.Pool({
      connectionString: TEST_URL!,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
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
    await client.query(`
      CREATE TABLE notifications (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        message      TEXT NOT NULL,
        details      JSONB,
        read_at      TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const db = await import('./db/index.js');
    if (typeof db.__setPoolForTest !== 'function') {
      throw new Error('db/index.ts missing __setPoolForTest hook for tests');
    }
    db.__setPoolForTest(admin);
    admin.on('connect', c => {
      c.query(`SET search_path TO "${SCHEMA}", public`).catch(() => { /* ignore */ });
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try { await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`); } catch { /* ignore */ }
      client.release();
    }
    if (admin) await admin.end();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await client.query('TRUNCATE notifications RESTART IDENTITY');
  });

  const baseDup = {
    eventId: 'evt-abc',
    camera: 'Front',
    timestamp: '2026-04-15T10:00:00.000Z',
    viewId: '00',
    visiblePath: '2026/04/15/Front_00_20260415100000.mp4',
    hiddenPath: 'backup/2026/04/15/Front_00_20260415100000.mp4',
  };

  async function readRows() {
    const r = await client.query(
      `SELECT user_id, kind, message, details, read_at FROM notifications ORDER BY id`,
    );
    return r.rows;
  }

  it('inserts a fresh notification on the first call for a new eventId', async () => {
    const result = await upsertDuplicateFileNotification(42, baseDup);
    expect(result).toEqual({ created: true, updated: false, skipped: false });

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 42,
      kind: 'duplicate_file',
      read_at: null,
    });
    expect(rows[0].details).toMatchObject({
      eventId: 'evt-abc',
      camera: 'Front',
      visiblePath: baseDup.visiblePath,
      hiddenPaths: [baseDup.hiddenPath],
    });
    expect(rows[0].message).toContain(baseDup.visiblePath);
    expect(rows[0].message).toContain(baseDup.hiddenPath);
  });

  it('appends a new hiddenPath and clears read_at on the same eventId', async () => {
    await upsertDuplicateFileNotification(42, baseDup);
    await client.query(`UPDATE notifications SET read_at = NOW()`);

    const result = await upsertDuplicateFileNotification(42, {
      ...baseDup,
      hiddenPath: 'archive/Front_00_20260415100000.mp4',
    });
    expect(result).toEqual({ created: false, updated: true, skipped: false });

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].details.hiddenPaths).toEqual([
      baseDup.hiddenPath,
      'archive/Front_00_20260415100000.mp4',
    ]);
    expect(rows[0].read_at).toBeNull();
    expect(rows[0].message).toContain('archive/Front_00_20260415100000.mp4');
  });

  it('is a no-op when the same hiddenPath is reported twice', async () => {
    await upsertDuplicateFileNotification(42, baseDup);
    await client.query(`UPDATE notifications SET read_at = NOW()`);
    const before = (await readRows())[0];

    const result = await upsertDuplicateFileNotification(42, baseDup);
    expect(result).toEqual({ created: false, updated: false, skipped: true });

    const after = (await readRows())[0];
    expect(after.details).toEqual(before.details);
    expect(after.message).toBe(before.message);
    expect(after.read_at).not.toBeNull();
  });

  it('keeps notifications for different eventIds separate', async () => {
    await upsertDuplicateFileNotification(42, baseDup);
    await upsertDuplicateFileNotification(42, { ...baseDup, eventId: 'evt-xyz' });

    const rows = await readRows();
    expect(rows).toHaveLength(2);
    const eventIds = rows.map(r => r.details.eventId).sort();
    expect(eventIds).toEqual(['evt-abc', 'evt-xyz']);
  });
});
