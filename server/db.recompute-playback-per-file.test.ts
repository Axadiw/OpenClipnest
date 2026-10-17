/**
 * Per-file fast-path for `recomputeEventsPlaybackReadyFor*`. Sister to
 * `db.recompute-playback-null-view.test.ts` — same fixture and same NULL
 * semantics, but every assertion runs through `recomputeEventsPlaybackReadyForFile`
 * instead of `recomputeEventsPlaybackReadyForOwner`.
 *
 * Two things to guard:
 *   1. Same per-row outcomes as the per-owner version (identical NULL-view
 *      semantics — no NULL bleed into NOT NULL columns, every CASE arm
 *      reachable via per-file lookup).
 *   2. Isolation — recomputing for ONE file must only touch events that
 *      reference that file (1-2 events). Unrelated events for the same
 *      owner stay at their pre-existing state.
 *
 * Real Postgres only — same gating as the per-owner test (skipped when
 * `RECOMPUTE_TEST_DATABASE_URL` / `DATABASE_URL` is unset).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { recomputeEventsPlaybackReadyForFile, THUMBNAIL_UNPLAYABLE } from './db/queries/events.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.RECOMPUTE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('recomputeEventsPlaybackReadyForFile — per-file fast path', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  const SCHEMA = `clipnest_recompute_per_file_test_${Date.now()}`;
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // Stable file IDs — set in seedFixture, asserted against in tests.
  let pendingFileId: number;
  let readyFileId: number;
  let badFileId: number;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: TEST_URL!,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        client = await pool.connect();
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
    if (lastErr) throw lastErr;
    await client!.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}"`);
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        uuid TEXT NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE file_metadata (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        s3_key TEXT NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processing_state TEXT NOT NULL DEFAULT 'pending_sidecar'
      )
    `);
    await client.query(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        thumbnail TEXT,
        playback_ready BOOLEAN NOT NULL DEFAULT FALSE,
        playback_unplayable BOOLEAN NOT NULL DEFAULT FALSE
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
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
      } catch { /* swallow — pool may already be closed */ }
      client.release();
    }
    if (pool) await pool.end();
  });

  async function seedFixture() {
    // Wipe — every test reseeds so the per-file recompute under test sees
    // a known starting state. event_view_files cascades on events delete.
    await client.query(`TRUNCATE events, file_metadata, users RESTART IDENTITY CASCADE`);
    await client.query(
      `INSERT INTO users (id, uuid) VALUES (1, $1)`,
      [UUID],
    );

    const r = await client.query<{ id: number; s3_key: string }>(
      `INSERT INTO file_metadata
         (owner_id, s3_key, processing_state, uploaded_at)
       VALUES
         (1, $1, 'pending_sidecar', NOW()),
         (1, $2, 'ready',           NOW()),
         (1, $3, 'unplayable',      NOW())
       RETURNING id, s3_key`,
      [`${UUID}/pending.mp4`, `${UUID}/ready.mp4`, `${UUID}/bad.mp4`],
    );
    pendingFileId = r.rows.find(x => x.s3_key.endsWith('pending.mp4'))!.id;
    readyFileId   = r.rows.find(x => x.s3_key.endsWith('ready.mp4'))!.id;
    badFileId     = r.rows.find(x => x.s3_key.endsWith('bad.mp4'))!.id;

    await client.query(
      `INSERT INTO events (id, owner_id, thumbnail) VALUES
        ('a-wide-only-nomatch',  1, 'thumb.jpg'),
        ('b-zoom-only-nomatch',  1, 'thumb.jpg'),
        ('c-wide-only-pending',  1, 'thumb.jpg'),
        ('d-zoom-only-pending',  1, 'thumb.jpg'),
        ('e-wide-only-bad',      1, 'thumb.jpg'),
        ('f-zoom-only-bad',      1, 'thumb.jpg'),
        ('g-dual-nomatch',       1, 'thumb.jpg'),
        ('h-dual-wide-pending',  1, 'thumb.jpg'),
        ('i-wide-only-ready',    1, 'thumb.jpg'),
        ('j-thumb-tombstone',    1, $1),
        ('k-dual-both-ready',    1, 'thumb.jpg'),
        ('l-wide-ready-nothumb', 1, NULL)
      `,
      [THUMBNAIL_UNPLAYABLE],
    );
    // View files mirror the original (wide_video, zoom_video) columns —
    // see also db.recompute-playback-null-view.test.ts for the same matrix.
    await client.query(`
      INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES
        ('a-wide-only-nomatch',  '00', 'unrelated.mp4'),
        ('b-zoom-only-nomatch',  '01', 'unrelated.mp4'),
        ('c-wide-only-pending',  '00', 'pending.mp4'),
        ('d-zoom-only-pending',  '01', 'pending.mp4'),
        ('e-wide-only-bad',      '00', 'bad.mp4'),
        ('f-zoom-only-bad',      '01', 'bad.mp4'),
        ('g-dual-nomatch',       '00', 'one.mp4'),
        ('g-dual-nomatch',       '01', 'two.mp4'),
        ('h-dual-wide-pending',  '00', 'pending.mp4'),
        ('h-dual-wide-pending',  '01', 'two.mp4'),
        ('i-wide-only-ready',    '00', 'ready.mp4'),
        ('j-thumb-tombstone',    '00', 'ready.mp4'),
        ('k-dual-both-ready',    '00', 'ready.mp4'),
        ('k-dual-both-ready',    '01', 'ready.mp4'),
        ('l-wide-ready-nothumb', '00', 'ready.mp4')
    `);
  }

  async function readEvents() {
    const r = await client.query(
      `SELECT id, playback_ready, playback_unplayable FROM events ORDER BY id`,
    );
    return r.rows as Array<{
      id: string;
      playback_ready: boolean;
      playback_unplayable: boolean;
    }>;
  }

  async function readEventById(id: string) {
    const rows = await readEvents();
    const row = rows.find(r => r.id === id);
    if (!row) throw new Error(`event ${id} not found`);
    return row;
  }

  it('recompute-for-file on the READY file flips its events to ready=true (single-view + dual-view)', async () => {
    await seedFixture();
    await recomputeEventsPlaybackReadyForFile(readyFileId, client);

    // i: single-view wide=ready, thumb set → ready
    expect(await readEventById('i-wide-only-ready')).toMatchObject({
      playback_ready: true, playback_unplayable: false,
    });
    // k: dual-view both=ready (same file used twice), thumb set → ready
    expect(await readEventById('k-dual-both-ready')).toMatchObject({
      playback_ready: true, playback_unplayable: false,
    });
    // j: ready file + tombstoned thumbnail → ready (files gate playback_ready
    // now, decision 6) AND unplayable (tombstone) — grid hides via unplayable.
    expect(await readEventById('j-thumb-tombstone')).toMatchObject({
      playback_ready: true, playback_unplayable: true,
    });
    // l: ready file but no thumbnail yet → READY (decision 6: visibility
    // decoupled from thumbnails; shows with a placeholder tile).
    expect(await readEventById('l-wide-ready-nothumb')).toMatchObject({
      playback_ready: true, playback_unplayable: false,
    });
  });

  it('recompute-for-file on the BAD file flips its events to unplayable=true', async () => {
    await seedFixture();
    await recomputeEventsPlaybackReadyForFile(badFileId, client);

    expect(await readEventById('e-wide-only-bad')).toMatchObject({
      playback_ready: false, playback_unplayable: true,
    });
    expect(await readEventById('f-zoom-only-bad')).toMatchObject({
      playback_ready: false, playback_unplayable: true,
    });
  });

  it('recompute-for-file on the PENDING file leaves its events not-ready / not-unplayable', async () => {
    await seedFixture();
    await recomputeEventsPlaybackReadyForFile(pendingFileId, client);

    // c: single-view wide=pending → not ready
    expect(await readEventById('c-wide-only-pending')).toMatchObject({
      playback_ready: false, playback_unplayable: false,
    });
    // d: single-view zoom=pending → not ready
    expect(await readEventById('d-zoom-only-pending')).toMatchObject({
      playback_ready: false, playback_unplayable: false,
    });
    // h: dual-view, wide=pending, zoom=unrelated → not ready (one side
    // pending AND the other side has no fm row → all_files_ready=false)
    expect(await readEventById('h-dual-wide-pending')).toMatchObject({
      playback_ready: false, playback_unplayable: false,
    });
  });

  it('recompute-for-file does NOT touch events that do not reference the file (isolation)', async () => {
    await seedFixture();

    // Stamp every unrelated event with a sentinel pre-state so we can prove
    // the per-file recompute did not overwrite it.
    await client.query(
      `UPDATE events SET playback_ready = TRUE, playback_unplayable = TRUE
       WHERE id IN ('a-wide-only-nomatch','b-zoom-only-nomatch',
                    'g-dual-nomatch',
                    'c-wide-only-pending','d-zoom-only-pending',
                    'e-wide-only-bad','f-zoom-only-bad')`,
    );

    await recomputeEventsPlaybackReadyForFile(readyFileId, client);

    // Sentinel rows untouched (still TRUE/TRUE) — recompute only walked
    // events whose wide_video/zoom_video matched 'ready.mp4'.
    for (const id of [
      'a-wide-only-nomatch', 'b-zoom-only-nomatch', 'g-dual-nomatch',
      'c-wide-only-pending', 'd-zoom-only-pending',
      'e-wide-only-bad', 'f-zoom-only-bad',
    ]) {
      const r = await readEventById(id);
      expect(r, `unrelated row ${id} was overwritten`).toMatchObject({
        playback_ready: true, playback_unplayable: true,
      });
    }

    // The four ready-file events were recomputed (different per-row outcomes
    // — covered in the dedicated test above).
  });

  it('recompute-for-file no-ops when the file_metadata row is gone (race with delete)', async () => {
    await seedFixture();
    await client.query(`DELETE FROM file_metadata WHERE id = $1`, [readyFileId]);

    // Should not throw, should not touch any event.
    await expect(
      recomputeEventsPlaybackReadyForFile(readyFileId, client),
    ).resolves.toBeUndefined();

    // Default-FALSE state preserved on every event.
    const rows = await readEvents();
    for (const r of rows) {
      expect(r.playback_ready, `${r.id} unexpectedly flipped`).toBe(false);
      expect(r.playback_unplayable, `${r.id} unexpectedly flipped`).toBe(false);
    }
  });

  it('does not write NULL into playback_ready / playback_unplayable for any single-view event', async () => {
    // Mirrors the per-owner null-view regression — runs the per-file path
    // for every distinct file in the fixture and asserts no NULL bleed.
    await seedFixture();
    for (const fid of [pendingFileId, readyFileId, badFileId]) {
      await recomputeEventsPlaybackReadyForFile(fid, client);
    }

    const rows = await readEvents();
    for (const r of rows) {
      expect(r.playback_ready, `playback_ready NULL on row ${r.id}`).not.toBeNull();
      expect(r.playback_unplayable, `playback_unplayable NULL on row ${r.id}`).not.toBeNull();
    }
  });
});
