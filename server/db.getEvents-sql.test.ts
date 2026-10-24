/**
 * Behavioural tests for `getEvents`.
 *
 * Each test works against an isolated scratch DB (created in beforeAll, dropped
 * in afterAll) with the drizzle migrator applied, so we test the real SQL logic
 * rather than asserting on query strings.
 *
 * Key behaviours pinned here:
 *
 *   1. Cursor predicate compares text-to-text (no ::timestamptz cast) — validated
 *      by inserting events with known timestamps and confirming pagination works.
 *   2. ORDER BY e.timestamp DESC, e.id DESC — dual-view events sharing a timestamp
 *      must sort consistently across pages.
 *   3. camera IN (...) filter returns only matching cameras.
 *   4. dateFrom/dateTo range filter returns only events in the window.
 *   5. rangeFrom/rangeTo half-open range filter.
 *   6. Daily time-of-day BETWEEN mask (timeFrom <= timeTo).
 *   7. Daily time-of-day wrap-around OR mask (timeFrom > timeTo).
 *   8. Cursor pagination: second page picks up where the first stopped.
 *   9. Count is invariant to cursor position (total never decrements on load-more).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getEvents } from './db/queries/events.js';
import { __setPoolForTest } from './db/index.js';
import { createScratchDb, type ScratchDb } from './testing/scratch-db.js';


const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;


/** Insert an event row plus a default view file (so it passes the EXISTS filter). */
async function insertEvent(
  pool: Pool,
  opts: {
    id: string;
    camera: string;
    timestamp: string;
    date: string;
    ownerId: number;
    /** When false, skip inserting a view file row (event has no playable media). */
    withViewFile?: boolean;
    playbackReady?: boolean;
    playbackUnplayable?: boolean;
  },
) {
  await pool.query(
    `INSERT INTO events (id, camera, timestamp, date, owner_id, playback_ready, playback_unplayable)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.id,
      opts.camera,
      opts.timestamp,
      opts.date,
      opts.ownerId,
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

describe.skipIf(!TEST_DB_URL)('getEvents behavioural', () => {
  let pool: Pool;
  let scratch: ScratchDb | undefined;
  let ownerId: number;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 5 });
    pool = scratch.pool;

    // Insert a plan + user required by FK constraints
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES (gen_random_uuid(), 'getevents-test@example.com', 'x', true, true, 1)
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

  it('camera filter returns only events from the requested camera', async () => {
    await insertEvent(pool, { id: 'e1', camera: 'cam-a', timestamp: '2026-01-01T10:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'e2', camera: 'cam-b', timestamp: '2026-01-01T11:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'e3', camera: 'cam-c', timestamp: '2026-01-01T12:00:00.000Z', date: '2026-01-01', ownerId });

    const { events } = await getEvents({ cameras: ['cam-a'], limit: 50, ownerId });
    expect(events.map(e => e.id)).toEqual(['e1']);
  });

  it('camera filter with multiple cameras returns only those cameras', async () => {
    await insertEvent(pool, { id: 'e1', camera: 'cam-a', timestamp: '2026-01-01T10:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'e2', camera: 'cam-b', timestamp: '2026-01-01T11:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'e3', camera: 'cam-c', timestamp: '2026-01-01T12:00:00.000Z', date: '2026-01-01', ownerId });

    const { events } = await getEvents({ cameras: ['cam-a', 'cam-b'], limit: 50, ownerId });
    expect(events.map(e => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('dateFrom/dateTo range returns events within the window', async () => {
    await insertEvent(pool, { id: 'before', camera: 'cam', timestamp: '2026-01-01T12:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'in-range', camera: 'cam', timestamp: '2026-01-05T12:00:00.000Z', date: '2026-01-05', ownerId });
    await insertEvent(pool, { id: 'after', camera: 'cam', timestamp: '2026-01-15T12:00:00.000Z', date: '2026-01-15', ownerId });

    const { events } = await getEvents({ dateFrom: '2026-01-02', dateTo: '2026-01-10', limit: 50, ownerId });
    expect(events.map(e => e.id)).toEqual(['in-range']);
  });

  it('ORDER BY is newest-first with id tie-breaker (dual-view events)', async () => {
    // Two events with the exact same timestamp — id tie-breaker must produce stable order
    const sharedTs = '2026-01-10T08:00:00.000Z';
    await insertEvent(pool, { id: 'e-aaa', camera: 'cam', timestamp: sharedTs, date: '2026-01-10', ownerId });
    await insertEvent(pool, { id: 'e-bbb', camera: 'cam', timestamp: sharedTs, date: '2026-01-10', ownerId });
    await insertEvent(pool, { id: 'e-ccc', camera: 'cam', timestamp: '2026-01-10T09:00:00.000Z', date: '2026-01-10', ownerId });

    const { events } = await getEvents({ limit: 50, ownerId });
    // Newest first; tied timestamps sort by id DESC
    expect(events[0].id).toBe('e-ccc');
    // e-bbb > e-aaa lexicographically, so bbb comes before aaa in DESC order
    expect(events[1].id).toBe('e-bbb');
    expect(events[2].id).toBe('e-aaa');
  });

  it('cursor pagination: second page continues from where first page ended', async () => {
    // Insert 5 events newest → oldest
    for (let i = 5; i >= 1; i--) {
      await insertEvent(pool, {
        id: `e${i}`,
        camera: 'cam',
        timestamp: `2026-01-0${i}T12:00:00.000Z`,
        date: `2026-01-0${i}`,
        ownerId,
      });
    }

    const page1 = await getEvents({ limit: 2, ownerId });
    expect(page1.events.map(e => e.id)).toEqual(['e5', 'e4']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getEvents({ limit: 2, cursor: page1.nextCursor!, ownerId });
    expect(page2.events.map(e => e.id)).toEqual(['e3', 'e2']);

    const page3 = await getEvents({ limit: 2, cursor: page2.nextCursor!, ownerId });
    expect(page3.events.map(e => e.id)).toEqual(['e1']);
    expect(page3.nextCursor).toBeNull();
  });

  it('total count is invariant to cursor position (does not shrink as user scrolls)', async () => {
    for (let i = 1; i <= 4; i++) {
      await insertEvent(pool, {
        id: `e${i}`,
        camera: 'cam',
        timestamp: `2026-01-0${i}T12:00:00.000Z`,
        date: `2026-01-0${i}`,
        ownerId,
      });
    }

    const page1 = await getEvents({ limit: 2, ownerId });
    const page2 = await getEvents({ limit: 2, cursor: page1.nextCursor!, ownerId });

    expect(page1.total).toBe(4);
    expect(page2.total).toBe(4); // total must NOT decrease to 2 on load-more
  });

  it('rangeFrom/rangeTo half-open range returns events in [from, to)', async () => {
    await insertEvent(pool, { id: 'before', camera: 'cam', timestamp: '2026-01-01T06:59:59.999Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'at-from', camera: 'cam', timestamp: '2026-01-01T07:00:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'in-range', camera: 'cam', timestamp: '2026-01-01T07:30:00.000Z', date: '2026-01-01', ownerId });
    await insertEvent(pool, { id: 'at-to', camera: 'cam', timestamp: '2026-01-01T08:00:00.000Z', date: '2026-01-01', ownerId });

    const { events } = await getEvents({
      rangeFrom: '2026-01-01T07:00:00.000Z',
      rangeTo: '2026-01-01T08:00:00.000Z',
      limit: 50,
      ownerId,
    });
    expect(events.map(e => e.id).sort()).toEqual(['at-from', 'in-range']);
    // at-to (== rangeTo) excluded; before excluded
  });

  it('daily time-of-day BETWEEN mask (timeFrom <= timeTo)', async () => {
    // Times are in ISO format position 12-16 (HH:MM)
    await insertEvent(pool, { id: 'before-window', camera: 'cam', timestamp: '2026-01-05T04:59:00.000Z', date: '2026-01-05', ownerId });
    await insertEvent(pool, { id: 'in-window', camera: 'cam', timestamp: '2026-01-05T07:30:00.000Z', date: '2026-01-05', ownerId });
    await insertEvent(pool, { id: 'after-window', camera: 'cam', timestamp: '2026-01-05T10:01:00.000Z', date: '2026-01-05', ownerId });

    const { events } = await getEvents({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      timeFrom: '05:00',
      timeTo: '10:00',
      limit: 50,
      ownerId,
    });
    expect(events.map(e => e.id)).toEqual(['in-window']);
  });

  it('daily time-of-day wrap-around OR mask (timeFrom > timeTo)', async () => {
    await insertEvent(pool, { id: 'midday', camera: 'cam', timestamp: '2026-01-05T12:00:00.000Z', date: '2026-01-05', ownerId });
    await insertEvent(pool, { id: 'late-night', camera: 'cam', timestamp: '2026-01-05T23:30:00.000Z', date: '2026-01-05', ownerId });
    await insertEvent(pool, { id: 'early-morning', camera: 'cam', timestamp: '2026-01-05T01:30:00.000Z', date: '2026-01-05', ownerId });

    const { events } = await getEvents({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      timeFrom: '22:00',
      timeTo: '02:00',
      limit: 50,
      ownerId,
    });
    // late-night (23:30 >= 22:00) and early-morning (01:30 <= 02:00) match; midday does not
    expect(events.map(e => e.id).sort()).toEqual(['early-morning', 'late-night']);
  });

  it('events without playable media are hidden from results', async () => {
    // No event_view_files row → filtered out by EXISTS check
    await insertEvent(pool, { id: 'no-media', camera: 'cam', timestamp: '2026-01-01T10:00:00.000Z', date: '2026-01-01', ownerId, withViewFile: false });
    await insertEvent(pool, { id: 'has-media', camera: 'cam', timestamp: '2026-01-01T11:00:00.000Z', date: '2026-01-01', ownerId });

    const { events } = await getEvents({ limit: 50, ownerId });
    expect(events.map(e => e.id)).toEqual(['has-media']);
  });

  it('events with playback_ready=false are hidden', async () => {
    await insertEvent(pool, { id: 'ready', camera: 'cam', timestamp: '2026-01-01T10:00:00.000Z', date: '2026-01-01', ownerId, playbackReady: true });
    await insertEvent(pool, { id: 'not-ready', camera: 'cam', timestamp: '2026-01-01T11:00:00.000Z', date: '2026-01-01', ownerId, playbackReady: false });

    const { events } = await getEvents({ limit: 50, ownerId });
    expect(events.map(e => e.id)).toEqual(['ready']);
  });
});
