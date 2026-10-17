/**
 * Integration tests for `replaceUserEvents` slot-overwrite semantics.
 *
 * The contract pinned here: on the force-full rebuild path, when an event id
 * already exists in DB, the new `wide_video` / `zoom_video` values from the
 * scan MUST overwrite the old ones (no COALESCE preservation). Otherwise a
 * historical merge-artifact (e.g. event id `Driveway_081523` carrying
 * `wide_video=Driveway_00_..._081525` from a pre-fix mergeNearbyEvents bug)
 * can never heal — the next force-full rebuild produces the correct
 * `wide_video=Driveway_00_..._081523`, but the COALESCE branch silently
 * keeps the old wrong value, and the orphan file stays unattached in
 * `file_metadata` with `processing_attempts=0` forever.
 *
 * Thumbnail keeps COALESCE — the thumbnail-worker writes that column,
 * not the scanner, so we must not clobber it on every rescan.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { replaceUserEvents } from './db/queries/events.js';
import type { CameraEvent } from './types.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.REPLACE_USER_EVENTS_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('replaceUserEvents — slot overwrite on force-full', () => {
  const SCHEMA = `clipnest_replace_user_events_test_${Date.now()}`;
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
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        camera TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        date TEXT NOT NULL,
        thumbnail TEXT,
        owner_id INTEGER NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE event_view_files (
        event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        view_id         TEXT NOT NULL,
        video_rel_path  TEXT NOT NULL,
        duration_ms     BIGINT,
        size_bytes      BIGINT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, view_id)
      )
    `);
    await client.query(`
      CREATE TABLE notifications (
        id SERIAL PRIMARY KEY,
        details JSONB
      )
    `);
    const db = await import('./db/index.js');
    if (typeof db.__setPoolForTest === 'function') {
      db.__setPoolForTest(admin);
      admin.on('connect', c => {
        c.query(`SET search_path TO "${SCHEMA}", public`).catch(() => { /* ignore */ });
      });
    } else {
      throw new Error('db/index.ts missing __setPoolForTest hook for tests');
    }
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
      } catch { /* ignore */ }
      client.release();
    }
    if (admin) await admin.end();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await client.query('TRUNCATE events CASCADE');
    await client.query('TRUNCATE notifications');
  });

  function evt(id: string, partial: Partial<CameraEvent> = {}): CameraEvent {
    return {
      id,
      camera: 'Driveway',
      timestamp: '2026-05-25T08:15:23.000Z',
      date: '2026/05/25',
      views: [],
      thumbnail: null,
      ...partial,
    };
  }

  /** Insert an event row + its view-file rows directly, mirroring the
   *  shape `replaceUserEvents` writes. The tests then re-run
   *  `replaceUserEvents` to assert overwrite semantics. */
  async function seedEvent(id: string, ownerId: number, views: Array<{ id: string; rel: string }>, thumbnail: string | null = null): Promise<void> {
    await client.query(
      `INSERT INTO events (id, camera, timestamp, date, thumbnail, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, 'Driveway', '2026-05-25T08:15:23.000Z', '2026/05/25', thumbnail, ownerId],
    );
    for (const l of views) {
      await client.query(
        `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, $2, $3)`,
        [id, l.id, l.rel],
      );
    }
  }

  /** Read back the view-file rows for an event as a Map<view_id, video_rel_path>. */
  async function readViews(eventId: string): Promise<Map<string, string>> {
    const r = await client.query(
      `SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1`,
      [eventId],
    );
    return new Map(r.rows.map(row => [row.view_id, row.video_rel_path]));
  }

  it('overwrites view-file rows when the new scan has different (correct) values', async () => {
    // Simulate a pre-fix merge artifact: DB row already has wrong wide pointing
    // at the +2s neighbor file because an old mergeNearbyEvents bug paired
    // zoom@T with wide@T+2s, leaving the exact-tsRaw wide as an orphan.
    const stale = '2026/05/25/Driveway_00_20260525081525.mp4'; // wrong wide (stolen from 081525)
    const correct = 'Driveway_00_20260525081523.mp4';          // root upload, matches event tsRaw
    const zoomPath = 'Driveway_01_20260525081523.mp4';

    await seedEvent('evt-merge-artifact', 99, [
      { id: '00', rel: stale },
      { id: '01', rel: zoomPath },
    ]);

    // Force-full scan produces the correct wide path (S3 LIST sees the orphan).
    await replaceUserEvents(99, [evt('evt-merge-artifact', {
      views: [
        { id: '00', videoRelPath: correct },
        { id: '01', videoRelPath: zoomPath },
      ],
    })]);

    const viewRows = await readViews('evt-merge-artifact');
    expect(viewRows.get('00')).toBe(correct);
    expect(viewRows.get('01')).toBe(zoomPath);
  });

  it('preserves existing thumbnail when the scan does not carry one (worker owns that column)', async () => {
    // Scanner never sets thumbnail; thumbnail-worker writes it asynchronously.
    // A force-full rescan must not clobber a generated thumbnail just because
    // the scanner re-saw the source mp4.
    const widePath = '2026/05/25/Driveway_00_20260525081523.mp4';
    const generatedThumb = '__generated__/evt-thumb-preserve.jpg';

    await seedEvent('evt-thumb-preserve', 99, [{ id: '00', rel: widePath }], generatedThumb);

    await replaceUserEvents(99, [evt('evt-thumb-preserve', {
      views: [{ id: '00', videoRelPath: widePath }],
      thumbnail: null,
    })]);

    const r = await client.query('SELECT thumbnail FROM events WHERE id = $1', ['evt-thumb-preserve']);
    expect(r.rows[0].thumbnail).toBe(generatedThumb);
  });

  it('drops a view row when the new scan no longer sees the file (S3 deletion reflected)', async () => {
    // If the file was deleted from S3 between scans, the force-full path
    // legitimately omits the wide view for an event that previously had it.
    // The DELETE-then-INSERT pattern in replaceUserEvents correctly removes
    // the orphan row instead of leaving stale view metadata behind.
    const stalePath = 'Driveway_00_20260525081523.mp4';

    await seedEvent('evt-deleted-wide', 99, [{ id: '00', rel: stalePath }]);

    await replaceUserEvents(99, [evt('evt-deleted-wide', {
      views: [{ id: '01', videoRelPath: 'Driveway_01_20260525081523.mp4' }],
    })]);

    const viewRows = await readViews('evt-deleted-wide');
    expect(viewRows.has('00')).toBe(false);
    expect(viewRows.get('01')).toBe('Driveway_01_20260525081523.mp4');
  });
});
