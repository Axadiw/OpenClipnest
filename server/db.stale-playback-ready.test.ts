/**
 * SQL semantics of `getOwnersWithStalePlaybackReady` — the feeder query for
 * the `reconcileStalePlaybackReady` safety-net pass.
 *
 * "Stale not-ready" = an event that has at least one view file, every linked
 * file_metadata row patch-ready, yet still sits at playback_ready=FALSE and
 * playback_unplayable=FALSE. Under the new rule (spec decision 6) the thumbnail
 * no longer gates playback_ready — an event with NULL thumbnail and ready files
 * is perfectly playable. The sweep therefore no longer filters on thumbnail
 * presence or the UNPLAYABLE tombstone; the tombstone check is handled by the
 * recompute itself (it sets playback_unplayable=TRUE) and the sweep's
 * `playback_unplayable=FALSE` guard stops revisiting such events.
 *
 * The flip side matters just as much: events with ANY missing/pending/
 * unplayable file are legitimately not-ready (the normal pipeline will get
 * to them) and MUST NOT be returned — otherwise the sweep would recompute
 * owners every minute for no reason.
 *
 * Real Postgres only — same gating as db.recompute-playback-per-file.test.ts
 * (skipped when `RECOMPUTE_TEST_DATABASE_URL` / `DATABASE_URL` is unset;
 * runs in CI).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { getOwnersWithStalePlaybackReady, THUMBNAIL_UNPLAYABLE } from './db/queries/events.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.RECOMPUTE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('getOwnersWithStalePlaybackReady — stale not-ready owner sweep', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  const SCHEMA = `clipnest_stale_playback_ready_test_${Date.now()}`;
  const UUID_1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const UUID_2 = 'ffffffff-0000-1111-2222-333333333333';

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

  async function wipe() {
    await client.query(`TRUNCATE events, file_metadata, users RESTART IDENTITY CASCADE`);
    await client.query(
      `INSERT INTO users (id, uuid) VALUES (1, $1), (2, $2)`,
      [UUID_1, UUID_2],
    );
  }

  /** Insert a ready file for `owner` at `rel` and return nothing. */
  async function seedReadyFile(owner: number, uuid: string, rel: string) {
    await client.query(
      `INSERT INTO file_metadata (owner_id, s3_key, processing_state)
       VALUES ($1, $2, 'ready')`,
      [owner, `${uuid}/${rel}`],
    );
  }

  async function seedEvent(
    id: string,
    owner: number,
    thumbnail: string | null,
    rels: string[],
  ) {
    await client.query(
      `INSERT INTO events (id, owner_id, thumbnail) VALUES ($1, $2, $3)`,
      [id, owner, thumbnail],
    );
    for (const [i, rel] of rels.entries()) {
      await client.query(
        `INSERT INTO event_view_files (event_id, view_id, video_rel_path)
         VALUES ($1, $2, $3)`,
        [id, String(i).padStart(2, '0'), rel],
      );
    }
  }

  it('returns the owner of a stale not-ready event whose files are all patch-ready', async () => {
    // The prod shape: dual-view event, both files ready, thumbnail present,
    // playback_ready never recomputed → stuck FALSE.
    await wipe();
    await seedReadyFile(1, UUID_1, 'wide.mp4');
    await seedReadyFile(1, UUID_1, 'zoom.mp4');
    await seedEvent('evt-stale', 1, 'thumb.jpg', ['wide.mp4', 'zoom.mp4']);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([1]);
  });

  it('returns the owner of a stale not-ready event with NULL thumbnail (new rule)', async () => {
    // Under spec decision 6, playback_ready no longer requires a thumbnail —
    // an event with NULL thumbnail and ready files is stale and MUST be swept.
    await wipe();
    await seedReadyFile(1, UUID_1, 'clip.mp4');
    await seedEvent('evt-stale-no-thumb', 1, null, ['clip.mp4']);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([1]);
  });

  it('does NOT return an owner whose only not-ready event still has a pending file', async () => {
    // One side ready, the other side still pending_sidecar — the normal
    // pipeline (markPlaybackPatchReady) will recompute when it lands. The
    // sweep must stay out of the way.
    await wipe();
    await seedReadyFile(1, UUID_1, 'wide.mp4');
    await client.query(
      `INSERT INTO file_metadata (owner_id, s3_key, processing_state)
       VALUES (1, $1, 'pending_sidecar')`,
      [`${UUID_1}/zoom.mp4`],
    );
    await seedEvent('evt-pending', 1, 'thumb.jpg', ['wide.mp4', 'zoom.mp4']);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([]);
  });

  it('returns an event whose thumbnail is the UNPLAYABLE tombstone (recompute will flip playback_unplayable)', async () => {
    // OLD rule: thumbnail=UNPLAYABLE was excluded from the sweep by a hard WHERE
    // condition. NEW rule: the tombstone condition was removed — the sweep now
    // returns such events so the recompute can flip playback_unplayable=TRUE,
    // which is what actually hides them from the grid and stops re-sweeping.
    await wipe();
    await seedReadyFile(1, UUID_1, 'wide.mp4');
    await seedEvent('evt-tombstone', 1, THUMBNAIL_UNPLAYABLE, ['wide.mp4']);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([1]);
  });

  it('does NOT return an event with zero event_view_files rows', async () => {
    // Fully-collapsed event (both views dropped) — nothing to play, nothing
    // to flip; recompute could never make it ready anyway.
    await wipe();
    await seedReadyFile(1, UUID_1, 'wide.mp4');
    await seedEvent('evt-no-views', 1, 'thumb.jpg', []);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([]);
  });

  it('returns each owner once even with multiple stale events (DISTINCT)', async () => {
    await wipe();
    await seedReadyFile(1, UUID_1, 'a.mp4');
    await seedReadyFile(1, UUID_1, 'b.mp4');
    await seedEvent('evt-stale-a', 1, 'thumb.jpg', ['a.mp4']);
    await seedEvent('evt-stale-b', 1, 'thumb.jpg', ['b.mp4']);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([1]);
  });

  it('excludes unplayable-flagged files, already-ready events and missing file rows; respects per-owner isolation', async () => {
    // Owner 1: one genuinely stale event → returned.
    // Owner 2: a grab-bag of NOT-stale shapes → not returned:
    //   - event already playback_ready=TRUE,
    //   - event whose file is processing_state=unplayable,
    //   - event whose view has NO file_metadata row at all (missing).
    await wipe();
    await seedReadyFile(1, UUID_1, 'stale.mp4');
    await seedEvent('evt-o1-stale', 1, 'thumb.jpg', ['stale.mp4']);

    await seedReadyFile(2, UUID_2, 'done.mp4');
    await seedEvent('evt-o2-done', 2, 'thumb.jpg', ['done.mp4']);
    await client.query(
      `UPDATE events SET playback_ready = TRUE WHERE id = 'evt-o2-done'`,
    );
    await client.query(
      `INSERT INTO file_metadata (owner_id, s3_key, processing_state)
       VALUES (2, $1, 'unplayable')`,
      [`${UUID_2}/bad.mp4`],
    );
    await seedEvent('evt-o2-bad', 2, 'thumb.jpg', ['bad.mp4']);
    await seedEvent('evt-o2-missing-fm', 2, 'thumb.jpg', ['never-uploaded.mp4']);

    const owners = await getOwnersWithStalePlaybackReady(50, client);
    expect(owners).toEqual([1]);
  });
});
