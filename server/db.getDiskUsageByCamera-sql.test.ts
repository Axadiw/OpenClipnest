/**
 * Behavioural tests for `getDiskUsageByCamera` — the query behind
 * `GET /api/v0/usage/by-camera` (the Storage screen's per-camera breakdown,
 * and the iOS Storage screen's "Recordings · N clips" total, which sums the
 * per-camera `eventCount`).
 *
 * Works against an isolated scratch DB (created in beforeAll, dropped in
 * afterAll) with the drizzle migrator applied, so we test the real SQL logic.
 *
 * Key behaviour pinned here:
 *
 *   `eventCount` must count only *displayable* events — the SAME predicate the
 *   grid uses in `getEvents` (not tombstoned `__unplayable__`, has playable
 *   media via event_view_files, playback_ready=TRUE, playback_unplayable=FALSE).
 *   Before this was filtered, the iOS Storage total (sum of eventCount) and the
 *   web per-camera footer disagreed with the grid header by the number of
 *   unplayable/zombie/not-ready rows (the "7975 vs 7961" report).
 *
 *   `durationSeconds` intentionally still counts ALL events (recorded-hours
 *   storage accounting), so this test also pins that asymmetry so a future
 *   refactor doesn't accidentally filter the duration too.
 *
 *   All THREE user-facing clip-count paths share one predicate
 *   (`displayableEventPredicateSql`): the grid total (`getEvents`), the Storage
 *   breakdown (`getDiskUsageByCamera`), and the Cameras grid's per-camera
 *   "N clips" (`getCameraDetails`). The cross-checks below assert they agree so
 *   the three can't silently drift apart again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getDiskUsageByCamera } from './db/queries/storage.js';
import { getEvents, getCameraDetails } from './db/queries/events.js';
import { __setPoolForTest } from './db/index.js';
import { createScratchDb, type ScratchDb } from './testing/scratch-db.js';


const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;


/** Insert an event row plus (optionally) a default view file. */
async function insertEvent(
  pool: Pool,
  opts: {
    id: string;
    camera: string;
    timestamp: string;
    date: string;
    ownerId: number;
    duration?: number;
    thumbnail?: string | null;
    /** When false, skip inserting a view file row (event has no playable media). */
    withViewFile?: boolean;
    playbackReady?: boolean;
    playbackUnplayable?: boolean;
  },
) {
  await pool.query(
    `INSERT INTO events (id, camera, timestamp, date, owner_id, duration, thumbnail, playback_ready, playback_unplayable)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      opts.id,
      opts.camera,
      opts.timestamp,
      opts.date,
      opts.ownerId,
      opts.duration ?? 10,
      opts.thumbnail ?? null,
      opts.playbackReady ?? true,
      opts.playbackUnplayable ?? false,
    ],
  );
  if (opts.withViewFile !== false) {
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
      [opts.id, `${opts.id}-wide.mp4`],
    );
  }
}

describe.skipIf(!TEST_DB_URL)('getDiskUsageByCamera behavioural', () => {
  let pool: Pool;
  let scratch: ScratchDb | undefined;
  let ownerId: number;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 5 });
    pool = scratch.pool;

    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES (gen_random_uuid(), 'diskusage-test@example.com', 'x', true, true, 1)
       RETURNING id`,
    );
    ownerId = u.rows[0].id;

    __setPoolForTest(pool);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE events RESTART IDENTITY CASCADE`);
  });

  it('eventCount counts only displayable events (matches the grid total)', async () => {
    // 3 displayable + 3 hidden, all on one camera.
    await insertEvent(pool, { id: 'ok-1', camera: 'cam', timestamp: '2026-01-01T10:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'ok-2', camera: 'cam', timestamp: '2026-01-01T11:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'ok-3', camera: 'cam', timestamp: '2026-01-01T12:00:00.000Z', date: '2026-01-01', ownerId });
    // Tombstoned (unplayable source) — hidden from grid, must not be counted.
    await insertEvent(pool, { id: 'unplayable', camera: 'cam', timestamp: '2026-01-01T13:00:00.000Z', date: '2026-01-01', ownerId, thumbnail: '__unplayable__' });
    // Zombie — no view file → hidden, must not be counted.
    await insertEvent(pool, { id: 'no-media', camera: 'cam', timestamp: '2026-01-01T14:00:00.000Z', date: '2026-01-01', ownerId, withViewFile: false });
    // Still processing — hidden, must not be counted.
    await insertEvent(pool, { id: 'not-ready', camera: 'cam', timestamp: '2026-01-01T15:00:00.000Z', date: '2026-01-01', ownerId, playbackReady: false });

    const byCamera = await getDiskUsageByCamera(ownerId);
    const cam = byCamera.find(c => c.cameraName === 'cam');
    expect(cam?.eventCount).toBe(3);

    // The Storage total (sum of per-camera eventCount) must equal the grid total.
    const sumEventCount = byCamera.reduce((s, c) => s + c.eventCount, 0);
    const { total } = await getEvents({ limit: 100, ownerId });
    expect(sumEventCount).toBe(total);

    // getCameraDetails (Cameras grid "N clips") must apply the SAME predicate.
    const details = await getCameraDetails(ownerId);
    expect(details.find(c => c.camera === 'cam')?.eventCount).toBe(3);
    expect(details.reduce((s, c) => s + c.eventCount, 0)).toBe(total);
  });

  it('all three count paths agree across multiple cameras (no drift)', async () => {
    // camA: 2 displayable + 1 of each hidden kind. camB: 1 displayable only.
    await insertEvent(pool, { id: 'a-ok-1', camera: 'camA', timestamp: '2026-02-01T10:00:00.000Z', date: '2026-02-01', ownerId });
    await insertEvent(pool, { id: 'a-ok-2', camera: 'camA', timestamp: '2026-02-01T11:00:00.000Z', date: '2026-02-01', ownerId });
    await insertEvent(pool, { id: 'a-tomb', camera: 'camA', timestamp: '2026-02-01T12:00:00.000Z', date: '2026-02-01', ownerId, thumbnail: '__unplayable__' });
    await insertEvent(pool, { id: 'a-zombie', camera: 'camA', timestamp: '2026-02-01T13:00:00.000Z', date: '2026-02-01', ownerId, withViewFile: false });
    await insertEvent(pool, { id: 'a-pending', camera: 'camA', timestamp: '2026-02-01T14:00:00.000Z', date: '2026-02-01', ownerId, playbackReady: false });
    await insertEvent(pool, { id: 'b-ok-1', camera: 'camB', timestamp: '2026-02-01T10:00:00.000Z', date: '2026-02-01', ownerId });

    const { total } = await getEvents({ limit: 100, ownerId });
    const byCamera = await getDiskUsageByCamera(ownerId);
    const details = await getCameraDetails(ownerId);

    // Grid total = 3 displayable (camA 2 + camB 1).
    expect(total).toBe(3);

    // Per-camera agreement between the Storage breakdown and the Cameras grid.
    const usageOf = (cam: string) => byCamera.find(c => c.cameraName === cam)?.eventCount ?? 0;
    const detailOf = (cam: string) => details.find(c => c.camera === cam)?.eventCount ?? 0;
    for (const cam of ['camA', 'camB']) {
      expect(detailOf(cam)).toBe(usageOf(cam));
    }
    expect(detailOf('camA')).toBe(2);
    expect(detailOf('camB')).toBe(1);

    // And both per-camera totals sum back to the grid total.
    expect(byCamera.reduce((s, c) => s + c.eventCount, 0)).toBe(total);
    expect(details.reduce((s, c) => s + c.eventCount, 0)).toBe(total);
  });

  it('durationSeconds still sums ALL events (storage accounting is whole-disk)', async () => {
    await insertEvent(pool, { id: 'ok', camera: 'cam', timestamp: '2026-01-01T10:00:00.000Z', date: '2026-01-01', ownerId, duration: 30 });
    await insertEvent(pool, { id: 'unplayable', camera: 'cam', timestamp: '2026-01-01T11:00:00.000Z', date: '2026-01-01', ownerId, duration: 12, thumbnail: '__unplayable__' });

    const byCamera = await getDiskUsageByCamera(ownerId);
    const cam = byCamera.find(c => c.cameraName === 'cam');
    // Only 1 displayable event, but duration counts both (30 + 12).
    expect(cam?.eventCount).toBe(1);
    expect(cam?.durationSeconds).toBeCloseTo(42, 5);
  });
});
