/**
 * Regression for `getProcessingStatus`:
 *
 * The "Processing N files…" banner could sit at a non-zero count forever for
 * one account, even though the grid showed 0 events.
 * Root cause was orphan rows in `file_metadata` that the count query
 * happily included:
 *   - HLS chunks (.m3u8/.m4s) leftover from the retired HLS feature
 *   - .jpg snapshots (no longer event-producing per scanner.ts:21-22)
 *   - directory-entry bug rows (s3_key ending in `/`, file_size_bytes=0)
 * None of these can ever flip processing_state to 'ready' (the worker only
 * patches video files) so the banner had no path back to zero.
 *
 * After migration 0007 the fix is encoded in `processing_state`:
 * the backfill sets orphans to 'not_applicable' or 'ready'/'unplayable'
 * so only 'pending_sidecar' rows appear in the banner.
 *
 * Real Postgres only — set PROCESSING_STATUS_TEST_DATABASE_URL (or fall
 * back to DATABASE_URL which CI sets) to a writable Postgres; otherwise
 * the suite skips.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { getProcessingStatus } from './db/queries/events.js';

// CI Postgres is shared with other test files. db.migrate.test.ts holds
// the worker for ~41s running ~100 DDLs; while it's running, this
// suite's `beforeAll` queues behind it. Per-test timeouts kept at 30s.
// Hook timeout is enforced via the per-`beforeAll` 2nd arg below —
// `vi.setConfig({ hookTimeout })` at module scope is not honored by
// vitest 1.x for module-level hooks (observed on CI).
vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL =
  process.env.PROCESSING_STATUS_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('getProcessingStatus — processing_state filter + file list', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  const SCHEMA = `clipnest_processing_status_test_${Date.now()}`;

  beforeAll(async () => {
    // `connectionTimeoutMillis` + retry: the self-hosted CI runner sometimes
    // creates a fresh PG cluster moments before tests start; pg_isready
    // (TCP listener) returns OK before the auth handshake fully accepts
    // backends. Without a per-attempt timeout, pool.connect() can hang
    // indefinitely and blow the hookTimeout. Mirrors the same retry pattern
    // in db.recompute-playback-null-view.test.ts.
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
      CREATE TABLE file_metadata (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        s3_bucket TEXT NOT NULL DEFAULT 'b',
        s3_key TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_size_bytes BIGINT NOT NULL DEFAULT 0,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processing_state TEXT NOT NULL DEFAULT 'pending_sidecar'
          CHECK (processing_state IN ('pending_sidecar','ready','unplayable','duplicate','unrecognized','not_applicable')),
        processing_attempts INT NOT NULL DEFAULT 0
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

  it('counts only pending_sidecar rows; excludes ready, not_applicable, unplayable, duplicate', async () => {
    // Mirror the orphan-row case via processing_state: only the three
    // pending_sidecar rows should appear in the banner.
    const ownerId = 42;
    await client.query(
      `INSERT INTO file_metadata (owner_id, s3_key, original_filename, uploaded_at, processing_state) VALUES
        -- pending: must be counted, ordered newest-first
        ($1, 'u/2026/05/08/newest.mp4', 'newest.mp4', '2026-05-08 12:00:00+00', 'pending_sidecar'),
        ($1, 'u/2026/05/08/middle.mp4', 'middle.mp4', '2026-05-08 11:00:00+00', 'pending_sidecar'),
        ($1, 'u/2026/05/05/oldest.mp4', 'oldest.mp4', '2026-05-05 10:00:00+00', 'pending_sidecar'),
        -- ready: excluded
        ($1, 'u/2026/05/08/done.mp4',   'done.mp4',   '2026-05-08 12:00:00+00', 'ready'),
        -- not_applicable (HLS/jpg/dir orphans backfilled to this): excluded
        ($1, 'u/2026/05/05/hls.m3u8',  'hls.m3u8',   '2026-05-05 10:00:00+00', 'not_applicable'),
        ($1, 'u/2026/05/08/snap.jpg',   'snap.jpg',   '2026-05-08 12:00:00+00', 'not_applicable'),
        -- unplayable: excluded
        ($1, 'u/2026/05/08/broken.mp4', 'broken.mp4', '2026-05-08 12:00:00+00', 'unplayable'),
        -- duplicate: excluded
        ($1, 'u/2026/05/08/dup.mp4',    'dup.mp4',    '2026-05-08 12:00:00+00', 'duplicate')`,
      [ownerId],
    );

    const status = await getProcessingStatus(ownerId, client);

    expect(status.inProgressCount).toBe(3);
    expect(status.inProgressFiles.map(f => f.filename)).toEqual([
      'newest.mp4',
      'middle.mp4',
      'oldest.mp4',
    ]);
  });

  it('returns zero for a user with only non-pending rows', async () => {
    const ownerId = 99;
    await client.query(
      `INSERT INTO file_metadata (owner_id, s3_key, original_filename, processing_state) VALUES
        ($1, 'orphan/a.m3u8', 'a.m3u8', 'not_applicable'),
        ($1, 'orphan/b.jpg',  'b.jpg',  'not_applicable'),
        ($1, 'orphan/done',   'done',   'ready')`,
      [ownerId],
    );
    const status = await getProcessingStatus(ownerId, client);
    expect(status.inProgressCount).toBe(0);
    expect(status.inProgressFiles).toEqual([]);
  });
});
