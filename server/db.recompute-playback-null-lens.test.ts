/**
 * Regression: NULL propagation in the per-owner playback recompute broke every
 * event of a user with single-view recordings. The original failure mode
 * was the legacy `recomputeEventsHlsReadyForOwner` writing NULL into the
 * NOT NULL `events.hls_ready` / `events.hls_unplayable` columns when one
 * view was NULL — `NULL IN (SELECT ...)` evaluates to NULL under Postgres
 * 3-valued logic, `FALSE OR NULL` = NULL, `NOT NULL` = NULL.
 *
 * The HLS schema has since been replaced (see #123, #124): the function is
 * now `recomputeEventsPlaybackReadyForOwner`, the columns are
 * `events.playback_ready` / `events.playback_unplayable`, and the per-file
 * state lives in `file_metadata.processing_state` (TEXT enum). The current
 * SQL uses `BOOL_AND` / `BOOL_OR` over a `LEFT JOIN` with explicit
 * `CASE WHEN ... IS NULL THEN TRUE/FALSE` arms, which folds NULL safety
 * into the aggregate.
 *
 * That makes the bug structurally hard to reintroduce — but the regression
 * test is still worth keeping. If anyone ever rewrites this back to
 * `IN (...) OR IN (...)` (or the moral equivalent) without thinking about
 * 3-valued logic, this test fires before Sentry does.
 *
 * Real Postgres only — mocks cannot reproduce 3-valued logic. Set
 * `RECOMPUTE_TEST_DATABASE_URL` (or fall back to `DATABASE_URL`, which CI
 * already sets) to a writable Postgres; otherwise the suite skips. CI runs
 * against the dockerized clipnest-db; locally any Postgres works.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { recomputeEventsPlaybackReadyForOwner, THUMBNAIL_UNPLAYABLE } from './db/queries/events.js';

// CI Postgres is shared with other test files. db.migrate.test.ts holds
// the worker for ~41s running ~100 DDLs in `runs DDL and bumps
// schema_version when stored version is stale`; while it's running, this
// suite's `beforeAll` (pool.connect → CREATE SCHEMA → CREATE TABLE)
// queues behind it. Per-test timeouts kept at 30s — once the schema is
// set up, individual tests are fast. The per-`beforeAll` 90s timeout
// passed below as the 2nd arg is what actually gates schema setup; the
// `vi.setConfig` call is kept only for the per-test timeout (testTimeout
// honors module-scope setConfig in vitest 1.x; hookTimeout does NOT —
// observed on CI: "Hook timed out in
// 30000ms" despite hookTimeout=90_000 here).
vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.RECOMPUTE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('recomputeEventsPlaybackReadyForOwner — NULL-view semantics', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  // Schema is namespaced so the test can't collide with anything else
  // sharing the database. Drop+recreate per test file.
  const SCHEMA = `clipnest_recompute_playback_null_test_${Date.now()}`;

  beforeAll(async () => {
    // `connectionTimeoutMillis` + retry: on the self-hosted CI runner the
    // cached PG cluster can pass `pg_isready` (TCP listener up) seconds
    // before authenticated client backends actually attach — the workflow's
    // pg_isready poll is at the listener layer, but the failing condition
    // is the auth handshake. Without a per-attempt timeout, pool.connect()
    // hangs indefinitely and blows the default 10s vitest hookTimeout
    // ("fail once, pass on rerun" pattern observed across #128/#132). Poll
    // at the actual auth layer instead, with bounded retries.
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
    // Minimal schema — only the columns recomputeEventsPlaybackReadyForOwner
    // reads. Mirrors the live shape from db.ts migrate() but stripped of
    // unrelated columns to keep the test self-contained.
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
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await client.query(
      `INSERT INTO users (id, uuid) VALUES (1, $1)`,
      [uuid],
    );

    // file_metadata: one PENDING (processing_state=pending_sidecar), one
    // READY (processing_state=ready), one BAD (processing_state=unplayable).
    // s3_key includes the uuid prefix; events.wide_video /
    // events.zoom_video store the relative path (everything after `<uuid>/`).
    await client.query(
      `INSERT INTO file_metadata
         (owner_id, s3_key, processing_state, uploaded_at)
       VALUES
         (1, $1, 'pending_sidecar', NOW()),
         (1, $2, 'ready',           NOW()),
         (1, $3, 'unplayable',      NOW())`,
      [`${uuid}/pending.mp4`, `${uuid}/ready.mp4`, `${uuid}/bad.mp4`],
    );

    // events fixtures — every single-view NULL combination + dual-view
    // controls + matched/unmatched/unplayable variants. Each row will be
    // UPDATE-d by recomputeEventsPlaybackReadyForOwner; the pre-UPDATE
    // values exist only to satisfy the NOT NULL constraints.
    //
    // thumbnail = 'thumb.jpg' for normal events, THUMBNAIL_UNPLAYABLE for
    // the tombstone case (j), NULL for one ready-files-but-no-thumb case.
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
    // View files mirror the original wide/zoom columns:
    //   (a) wide-only unrelated, (b) zoom-only unrelated, (c) wide-only pending,
    //   (d) zoom-only pending, (e) wide-only bad, (f) zoom-only bad,
    //   (g) dual neither matches, (h) dual wide pending + zoom unrelated,
    //   (i) wide-only ready, (j) wide-only ready (tombstone thumbnail),
    //   (k) dual both ready, (l) wide-only ready but thumbnail NULL.
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
      playback_ready: boolean | null;
      playback_unplayable: boolean | null;
    }>;
  }

  it('does not write NULL into playback_ready / playback_unplayable for any single-view event', async () => {
    await seedFixture();

    // Pass our `client` so the function reuses our session, which carries
    // the search_path we set in beforeAll. Without this hook the function
    // would go through the module-level pool and never see our schema.
    await recomputeEventsPlaybackReadyForOwner(1, client);

    const rows = await readEvents();
    // None of these may be NULL — that's the production bug we're guarding.
    for (const r of rows) {
      expect(r.playback_ready, `playback_ready NULL on row ${r.id}`).not.toBeNull();
      expect(r.playback_unplayable, `playback_unplayable NULL on row ${r.id}`).not.toBeNull();
    }

    // Concrete per-row expectations.
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    // (a) wide non-NULL, no fm match → not ready (file unknown), not unplayable
    expect(byId['a-wide-only-nomatch']).toMatchObject({ playback_ready: false, playback_unplayable: false });
    // (b) zoom non-NULL, no fm match → same
    expect(byId['b-zoom-only-nomatch']).toMatchObject({ playback_ready: false, playback_unplayable: false });
    // (c) wide matches pending → not ready, not unplayable
    expect(byId['c-wide-only-pending']).toMatchObject({ playback_ready: false, playback_unplayable: false });
    // (d) zoom matches pending → same
    expect(byId['d-zoom-only-pending']).toMatchObject({ playback_ready: false, playback_unplayable: false });
    // (e) wide matches bad → unplayable
    expect(byId['e-wide-only-bad']).toMatchObject({ playback_ready: false, playback_unplayable: true });
    // (f) zoom matches bad → unplayable
    expect(byId['f-zoom-only-bad']).toMatchObject({ playback_ready: false, playback_unplayable: true });
    // (g) dual-view, neither matches → not ready, not unplayable
    expect(byId['g-dual-nomatch']).toMatchObject({ playback_ready: false, playback_unplayable: false });
    // (h) dual-view, wide pending → not ready (one side not ready)
    expect(byId['h-dual-wide-pending']).toMatchObject({ playback_ready: false, playback_unplayable: false });
    // (i) single-view wide ready + thumb → ready
    expect(byId['i-wide-only-ready']).toMatchObject({ playback_ready: true, playback_unplayable: false });
    // (j) tombstoned thumbnail + ready file → ready (files gate playback_ready
    // now, decision 6) BUT unplayable (tombstone) — grid hides it via the
    // playback_unplayable=TRUE filter.
    expect(byId['j-thumb-tombstone']).toMatchObject({ playback_ready: true, playback_unplayable: true });
    // (k) dual-view both ready + thumb → ready
    expect(byId['k-dual-both-ready']).toMatchObject({ playback_ready: true, playback_unplayable: false });
    // (l) ready file but no thumbnail yet → READY (decision 6: visibility is
    // decoupled from thumbnails; the event shows with a placeholder tile).
    expect(byId['l-wide-ready-nothumb']).toMatchObject({ playback_ready: true, playback_unplayable: false });
  });
});
