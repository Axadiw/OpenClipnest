/**
 * DB-level integration tests for completeUpload (Task 5.5).
 *
 * Uses a scratch database (createScratchDb + __setPoolForTest) so
 * the real completeUpload function runs against an isolated Postgres database.
 *
 * Run with a Postgres URL:
 *   DATABASE_URL_TEST=... npx vitest run server/services/ingest/completeUpload.db.test.ts
 *
 * Without a test DB these tests are skipped — DO NOT remove the guard.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createScratchDb, type ScratchDb } from '../../testing/scratch-db.js';
import { story } from '../../testing/story.js';
import { __setPoolForTest } from '../../db/index.js';
import { completeUpload } from './completeUpload.js';
import { removeDeletedFileFromEvents, getEventsMissingThumbnail } from '../../db/queries/events.js';
import { relinkUnlinkedFiles } from './relinkUnlinkedFiles.js';

// Stub out Redis SETNX in relinkUnlinkedFiles so the DB tests don't need a
// real Redis connection. Hoisted by Vitest to run before module evaluation.
vi.mock('../streamsClient.js', () => ({
  publishThumbnailUnique: vi.fn().mockResolvedValue('published'),
}));

// Migrations are three levels up from server/services/ingest/ → server/db/migrations/

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Format a Date as a 14-digit tsRaw: YYYYMMDDHHMMSS */
function fmtTs(d: Date): string {
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0')
  );
}

/** Add seconds to a 14-digit tsRaw string — used for constructing test filenames.
 *  Date.UTC keeps the digit round-trip TZ-independent (fmtTs reads getUTC*
 *  components); a local-time constructor would shift the output by the host
 *  TZ offset and break the 14s-apart fixtures on non-UTC dev machines. */
function addSecondsToTs(ts: string, secs: number): string {
  const d = new Date(Date.UTC(
    Number(ts.slice(0, 4)),
    Number(ts.slice(4, 6)) - 1,
    Number(ts.slice(6, 8)),
    Number(ts.slice(8, 10)),
    Number(ts.slice(10, 12)),
    Number(ts.slice(12, 14)),
  ));
  d.setTime(d.getTime() + secs * 1000);
  return fmtTs(d);
}

/** Build the base64url event id the way buildEvents does. */
function buildEventId(userUuid: string, ts: string, camera: string): string {
  const yyyy = ts.slice(0, 4);
  const mm = ts.slice(4, 6);
  const dd = ts.slice(6, 8);
  const dateStr = `${yyyy}/${mm}/${dd}`;
  const groupKey = `${userUuid}/${dateStr}/${camera}_${ts}`;
  return Buffer.from(groupKey).toString('base64url');
}

// ── test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!TEST_DB_URL)('completeUpload DB integration', () => {
  let pool: Pool;
  let scratch: ScratchDb | undefined;
  let userUuid: string;
  let userId: number;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 10 });
    pool = scratch.pool;

    // Seed a plan required by users FK
    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes)
       VALUES (1, 'free', 1000000000, 1000000000) ON CONFLICT DO NOTHING`,
    );

    // Redirect the app db handle to the scratch database pool
    __setPoolForTest(pool);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  }, 60_000);

  beforeEach(async () => {
    // Truncate in dependency order so FK constraints don't block
    await pool.query(`TRUNCATE event_view_files, events, file_metadata, notifications, users RESTART IDENTITY CASCADE`);

    // Insert one user with camera_profile_mode='auto' (→ GLOBAL_CAMERA_PROFILES)
    const u = await pool.query<{ id: number; uuid: string }>(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id, camera_profile_mode)
       VALUES (gen_random_uuid(), 'cu-test@example.com', 'x', true, true, 1, 'auto')
       RETURNING id, uuid`,
    );
    userId = u.rows[0].id;
    userUuid = u.rows[0].uuid;
  }, 60_000);

  // ── Case 1: root wide file creates event + elf + pending_sidecar ──────────

  it('case 1: root wide creates event, elf (view 00), fm state pending_sidecar', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Root-path Driveway_00_<ts>.mp4 tworzy event, event_view_files (view=00) i file_metadata z processing_state=pending_sidecar.');

    const ts = '20260612121935';
    const s3Key = `${userUuid}/Driveway_00_${ts}.mp4`;
    const expectedEventId = buildEventId(userUuid, ts, 'Driveway');

    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });

    expect(result.created).toBe(true);
    expect(result.state).toBe('pending_sidecar');
    expect((result as { eventId?: string }).eventId).toBe(expectedEventId);

    // Assert event row
    const { rows: evRows } = await pool.query(
      `SELECT id, camera FROM events WHERE id = $1`,
      [expectedEventId],
    );
    expect(evRows).toHaveLength(1);
    expect(evRows[0].camera).toBe('Driveway');

    // Assert elf row (view 00)
    const { rows: elfRows } = await pool.query(
      `SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1`,
      [expectedEventId],
    );
    expect(elfRows).toHaveLength(1);
    expect(elfRows[0].view_id).toBe('00');

    // Assert fm state
    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('pending_sidecar');
  });

  // ── Case 2: THE regression — root zoom 14s later attaches to the same event ─

  it('case 2 (regression): root zoom 14s later → NO new event, elf view 01 on same event', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Regresja 2026-06-12: Driveway_01 uploadowany 14s po Driveway_00 łączy się z tym samym eventem (brak duplikatu). Dokładny kształt incydentu produkcyjnego.');

    const ts00 = '20260612121935';
    const ts01 = addSecondsToTs(ts00, 14); // 14s later
    const s3KeyWide = `${userUuid}/Driveway_00_${ts00}.mp4`;
    const s3KeyZoom = `${userUuid}/Driveway_01_${ts01}.mp4`;
    const expectedEventId = buildEventId(userUuid, ts00, 'Driveway');

    // Upload wide first
    const r1 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3KeyWide,
      originalFilename: `Driveway_00_${ts00}.mp4`,
      fileSizeBytes: 12345,
    });
    expect(r1.state).toBe('pending_sidecar');
    expect((r1 as { eventId?: string }).eventId).toBe(expectedEventId);

    // Upload zoom 14s later
    const r2 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3KeyZoom,
      originalFilename: `Driveway_01_${ts01}.mp4`,
      fileSizeBytes: 11111,
    });
    expect(r2.state).toBe('pending_sidecar');
    // Must attach to the SAME event, not create a new one
    expect((r2 as { eventId?: string }).eventId).toBe(expectedEventId);

    // Exactly 1 event row in the DB
    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(1);

    // Both view 00 and 01 exist
    const { rows: elfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
      [expectedEventId],
    );
    expect(elfRows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);
  });

  // ── Case 2b: THE worker-duration race — view 00's sidecar lands before view 01 ─
  it('case 2b (regression): worker sets view 00 duration before view 01 (14s later) arrives → still ONE event', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Wyścig z workerem (po wycofaniu skanera): worker zbuduje sidecar widoku 00 i zapisuje events.duration ZANIM dotrze widok 01 (14s później). Zanim dodano tolerancję skew-u, znana krótka duration zawężała okno dopasowania do ~7s i para rozpadała się na dwa eventy. Teraz tolerancja zegarowa (≤30s) jest sprawdzana niezależnie od duration, więc para nadal łączy się w jedno zdarzenie.');
    const ts00 = '20260612120000';
    const ts01 = addSecondsToTs(ts00, 14);
    const r1 = await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: `${userUuid}/CamR_00_${ts00}.mp4`, originalFilename: `CamR_00_${ts00}.mp4`, fileSizeBytes: 84794 });
    // Simulate the thumbnail worker finishing view 00's sidecar in the
    // inter-upload gap: updateEventDuration writes events.duration before the
    // 2nd view's completeUpload runs.
    await pool.query(`UPDATE events SET duration = 2 WHERE id = $1`, [(r1 as { eventId?: string }).eventId]);
    const r2 = await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: `${userUuid}/CamR_01_${ts01}.mp4`, originalFilename: `CamR_01_${ts01}.mp4`, fileSizeBytes: 84794 });
    // Must attach to the SAME event as view 00, despite view 00's known duration.
    expect((r2 as { eventId?: string }).eventId).toBe((r1 as { eventId?: string }).eventId);
    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(1);
    const { rows: elfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
      [(r1 as { eventId?: string }).eventId],
    );
    expect(elfRows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);
  });

  // ── Case 2c: delete-notify cleanup of a proximity-merged view ─────────────
  it('case 2c (regression): deleting a merged dual-view file removes the event via elf path, not derived id', async (ctx) => {
    story(ctx, 'Bug: po scaleniu dual-view event-keeper trzyma WCZEŚNIEJSZY tsRaw, więc plik późniejszego widoku żyje na evencie o innym id niż id wyliczone z jego nazwy. Stary delete-notify wyliczał event z nazwy pliku → trafiał w nieistniejący event → fm znikało, ale elf+event zostawały osierocone (0 B + residualny event). Fix: znajdź event po event_view_files.video_rel_path i skasuj gdy nie ma widoków.');
    const tsKeep = '20260608142809';
    const tsLate = addSecondsToTs(tsKeep, 1); // +1 s — the merge artifact off-by-one
    // view 01 first → creates keeper event id'd from tsKeep
    const r1 = await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: `${userUuid}/Back_01_${tsKeep}.mp4`, originalFilename: `Back_01_${tsKeep}.mp4`, fileSizeBytes: 1000 });
    // view 00 1 s later → merges into the keeper (its file's tsRaw ≠ keeper id)
    const r2 = await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: `${userUuid}/Back_00_${tsLate}.mp4`, originalFilename: `Back_00_${tsLate}.mp4`, fileSizeBytes: 1000 });
    const keeperId = buildEventId(userUuid, tsKeep, 'Back');
    expect((r1 as { eventId?: string }).eventId).toBe(keeperId);
    expect((r2 as { eventId?: string }).eventId).toBe(keeperId); // merged, not a 2nd event
    const { rows: vrows } = await pool.query(`SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`, [keeperId]);
    expect(vrows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);

    // ROOT CAUSE (now fixed): the later view's filename derives a DIFFERENT
    // (non-existent) event id. The retired derive-from-filename delete path
    // targeted `derivedFromLate`, missed the keeper, and orphaned the elf+event.
    const derivedFromLate = buildEventId(userUuid, tsLate, 'Back');
    expect(derivedFromLate).not.toBe(keeperId);

    // FIX: path-based removal hits the real keeper.
    const d1 = await removeDeletedFileFromEvents(userId, `Back_00_${tsLate}.mp4`);
    expect(d1.deletedEventIds).toEqual([]); // keeper still has view 01
    const { rows: after1 } = await pool.query(`SELECT view_id FROM event_view_files WHERE event_id = $1`, [keeperId]);
    expect(after1.map((r: { view_id: string }) => r.view_id)).toEqual(['01']);
    const d2 = await removeDeletedFileFromEvents(userId, `Back_01_${tsKeep}.mp4`);
    expect(d2.deletedEventIds).toEqual([keeperId]); // last view gone → event deleted
    const { rows: ev } = await pool.query(`SELECT count(*)::int AS c FROM events WHERE owner_id = $1`, [userId]);
    expect(ev[0].c).toBe(0);
  });

  // ── Case 3: keeper swap when zoom arrives first and wide is 14s EARLIER ────

  it('case 3: keeper swap — later-arriving zoom first, then wide 14s earlier → event id is wide id', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Keeper swap: zoom uploadowany pierwszy, potem wide 14s wcześniej. Event id powinien być wide, view zoom przeniesiony, stary event zoom usunięty.');

    const tsWide = '20260612121935';
    const tsZoom = addSecondsToTs(tsWide, 14); // zoom is 14s LATER in time
    // But zoom arrives first in the system
    const s3KeyZoom = `${userUuid}/Driveway_01_${tsZoom}.mp4`;
    const s3KeyWide = `${userUuid}/Driveway_00_${tsWide}.mp4`;

    const wideEventId = buildEventId(userUuid, tsWide, 'Driveway');
    const zoomEventId = buildEventId(userUuid, tsZoom, 'Driveway');
    expect(wideEventId).not.toBe(zoomEventId); // sanity

    // Zoom arrives first — creates its own event
    const r1 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3KeyZoom,
      originalFilename: `Driveway_01_${tsZoom}.mp4`,
      fileSizeBytes: 11111,
    });
    expect(r1.state).toBe('pending_sidecar');
    expect((r1 as { eventId?: string }).eventId).toBe(zoomEventId);

    // Sanity: zoom event exists, wide does not
    const { rows: before } = await pool.query(`SELECT id FROM events WHERE owner_id = $1 ORDER BY id`, [userId]);
    expect(before.map((r: { id: string }) => r.id)).toContain(zoomEventId);
    expect(before.map((r: { id: string }) => r.id)).not.toContain(wideEventId);

    // Wide arrives — is 14s EARLIER → triggers keeper swap
    const r2 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3KeyWide,
      originalFilename: `Driveway_00_${tsWide}.mp4`,
      fileSizeBytes: 12345,
    });
    expect(r2.state).toBe('pending_sidecar');
    // Must use the wide event id (it is the keeper — earlier timestamp)
    expect((r2 as { eventId?: string }).eventId).toBe(wideEventId);

    // Only 1 event remains (the wide one; the zoom event was deleted)
    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(1);
    expect(evRows[0].id).toBe(wideEventId);

    // Both views (00 and 01) are on the wide event
    const { rows: elfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
      [wideEventId],
    );
    expect(elfRows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);
  });

  // ── Case 4: duplicate (same camera+view+tsRaw, different path) ────────────

  it('case 4: duplicate — same camera+view+ts at two different paths → second fm state=duplicate, first elf untouched', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Duplikat: ta sama kamera+view+tsRaw pod dwoma ścieżkami. Drugi plik dostaje processing_state=duplicate; elf pierwszego pliku nienaruszony.');

    const ts = '20260612140000';
    const s3Key1 = `${userUuid}/Driveway_00_${ts}.mp4`;
    // Different path: as if uploaded to a dated folder
    const s3Key2 = `${userUuid}/2026/06/12/Driveway_00_${ts}.mp4`;

    const r1 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3Key1,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });
    expect(r1.state).toBe('pending_sidecar');

    const r2 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3Key2,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });
    expect(r2.state).toBe('duplicate');

    // Second file has processing_state=duplicate
    const { rows: fmRows2 } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key2],
    );
    expect(fmRows2[0].processing_state).toBe('duplicate');

    // First file's elf row is still pointing to the original rel path
    const eventId = buildEventId(userUuid, ts, 'Driveway');
    const { rows: elfRows } = await pool.query(
      `SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1 AND view_id = '00'`,
      [eventId],
    );
    expect(elfRows).toHaveLength(1);
    // The first file's rel path (strip uuid prefix)
    expect(elfRows[0].video_rel_path).toBe(`Driveway_00_${ts}.mp4`);
  });

  // ── Case 5: unrecognized filename → state unrecognized, no event ──────────

  it('case 5: unrecognized name → state=unrecognized, no event', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Nierozpoznana nazwa pliku (garbage_name.mp4) → processing_state=unrecognized, brak eventu i elf.');

    const s3Key = `${userUuid}/garbage_name.mp4`;
    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: 'garbage_name.mp4',
      fileSizeBytes: 999,
    });

    expect(result.state).toBe('unrecognized');

    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('unrecognized');

    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(0);
  });

  // ── Case 6: jpg → not_applicable, no event ────────────────────────────────

  it('case 6: jpg file → state=not_applicable, no event', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Plik jpg → processing_state=not_applicable, brak eventu.');

    const s3Key = `${userUuid}/Driveway_00_20260612121945.jpg`;
    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: 'Driveway_00_20260612121945.jpg',
      fileSizeBytes: 500,
    });

    expect(result.state).toBe('not_applicable');

    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('not_applicable');

    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(0);
  });

  // ── Case 7: idempotent re-run of case 1 ───────────────────────────────────

  it('case 7: idempotent re-run → created=false, still 1 event + 1 elf', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Idempotentność: ponowne wywołanie z tym samym s3Key zwraca created=false i nie tworzy duplikatów eventu ani elf.');

    const ts = '20260612121935';
    const s3Key = `${userUuid}/Driveway_00_${ts}.mp4`;
    const input = {
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    };

    const r1 = await completeUpload(input);
    expect(r1.created).toBe(true);
    expect(r1.state).toBe('pending_sidecar');

    // Re-run with same input
    const r2 = await completeUpload(input);
    expect(r2.created).toBe(false);
    expect(r2.state).toBe('pending_sidecar');

    // Still exactly 1 event
    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(1);

    // Still exactly 1 elf
    const { rows: elfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1`,
      [evRows[0].id],
    );
    expect(elfRows).toHaveLength(1);
  });

  // ── Case 8: concurrency — 20× parallel wide+zoom pairs all merge ──────────

  it('case 8: concurrency — 20× Promise.all wide+zoom pairs → each pair ends as 1 event + 2 elf rows', { timeout: 60_000 }, async (ctx) => {
    story(ctx, 'Concurrent: 20 par wide+zoom uploadowanych równolegle. Dzięki advisory lock (user, camera) każda para kończy się 1 eventem i 2 elf wierszami. Keeper to zawsze plik o wcześniejszym timestamp (wide_00), więc event id jest deterministyczny.');

    const PAIRS = 20;
    const camera = 'Concurrent';
    // Use a fixed base time, vary by pair index so pairs don't interfere with each other
    const baseEpoch = Date.UTC(2026, 5, 12, 10, 0, 0);

    const pairs = Array.from({ length: PAIRS }, (_, i) => {
      const wideEpoch = baseEpoch + i * 300_000; // 5 min apart per pair → no cross-pair match
      const zoomEpoch = wideEpoch + 14_000; // zoom 14s after wide
      const tsWide = fmtTs(new Date(wideEpoch));
      const tsZoom = fmtTs(new Date(zoomEpoch));
      const s3Wide = `${userUuid}/${camera}_00_${tsWide}.mp4`;
      const s3Zoom = `${userUuid}/${camera}_01_${tsZoom}.mp4`;
      // Keeper convention is deterministic: earlier timestamp = wide (_00).
      const keeperEventId = buildEventId(userUuid, tsWide, camera);
      const zoomEventId = buildEventId(userUuid, tsZoom, camera);
      return { tsWide, tsZoom, s3Wide, s3Zoom, keeperEventId, zoomEventId };
    });

    // Run all wide+zoom pairs concurrently
    await Promise.all(
      pairs.flatMap(({ tsWide, tsZoom, s3Wide, s3Zoom }) => [
        completeUpload({
          userId,
          userUuid,
          s3Bucket: 'recordings',
          s3Key: s3Wide,
          originalFilename: `${camera}_00_${tsWide}.mp4`,
          fileSizeBytes: 1000,
        }),
        completeUpload({
          userId,
          userUuid,
          s3Bucket: 'recordings',
          s3Key: s3Zoom,
          originalFilename: `${camera}_01_${tsZoom}.mp4`,
          fileSizeBytes: 1000,
        }),
      ]),
    );

    // Each pair must have produced exactly 1 event (the keeper = wide) with
    // both view ids, and the zoom's own event must not exist.
    for (const { keeperEventId, zoomEventId } of pairs) {
      // Keeper event must exist with exactly 2 elf rows
      const { rows: elfRows } = await pool.query(
        `SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
        [keeperEventId],
      );
      expect(elfRows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);

      // Zoom's standalone event must not exist (either never created, or
      // merged/deleted via keeper swap)
      const { rows: zoomEvRows } = await pool.query(
        `SELECT id FROM events WHERE id = $1`,
        [zoomEventId],
      );
      expect(zoomEvRows).toHaveLength(0);
    }

    // Total event count must be exactly PAIRS
    const { rows: totalEv } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events WHERE owner_id = $1 AND camera = $2`,
      [userId, camera],
    );
    expect(totalEv[0].n).toBe(PAIRS);
  });

  // ── Case 9: re-ingest clears a stale duplicate tombstone (Fix A) ──────────

  it('case 9: re-ingest clears a stale duplicate tombstone → state pending_sidecar, fm cleared, elf exists', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Fix A regresja: plik wcześniej oznaczony jako duplicate (twin usunięty) po ponownym ingest dostaje processing_state=pending_sidecar. Weryfikuje stale-terminal reconciliation.');

    const ts = '20260612150000';
    const s3Key1 = `${userUuid}/Driveway_00_${ts}.mp4`; // "visible" twin — will be removed
    const s3Key2 = `${userUuid}/2026/06/12/Driveway_00_${ts}.mp4`; // tombstoned as duplicate
    const eventId = buildEventId(userUuid, ts, 'Driveway');

    // Step 1: upload both files to produce a duplicate tombstone (case-4 shape)
    await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3Key1,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });
    const r2 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3Key2,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });
    expect(r2.state).toBe('duplicate');

    // Verify tombstone is in place
    const { rows: tombstoneRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key2],
    );
    expect(tombstoneRows[0].processing_state).toBe('duplicate');

    // Step 2: simulate deletion of the visible twin's elf row + event (twin was deleted by user)
    await pool.query(`DELETE FROM event_view_files WHERE event_id = $1 AND view_id = '00'`, [eventId]);
    await pool.query(`DELETE FROM events WHERE id = $1`, [eventId]);

    // Step 3: re-ingest the previously-tombstoned file (now it should be the sole owner)
    const r3 = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3Key2,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });

    // Must succeed as pending_sidecar, not stay duplicate
    expect(r3.state).toBe('pending_sidecar');

    // fm row must be cleared
    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key2],
    );
    expect(fmRows[0].processing_state).toBe('pending_sidecar');

    // elf row must exist
    const { rows: elfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1 AND view_id = '00'`,
      [eventId],
    );
    expect(elfRows).toHaveLength(1);
  });

  // ── Case 11: relinkUnlinkedFiles heals a legacy orphan fm row ─────────────

  it('relinkUnlinkedFiles links a legacy orphan fm row through the ingest path', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'relinkUnlinkedFiles: fm wiersz (video ext, pending_sidecar, bez elf/event) dla parseowalnego root key → po wywołaniu: event istnieje, elf (view 01), fm nadal pending_sidecar, return 1. Drugi fm z nieparseowalną nazwą → processing_state=unrecognized, brak eventu, nie liczony jako healed.');

    const ts = '20260612121949';
    const s3Key = `${userUuid}/Driveway_01_${ts}.mp4`;

    // Seed 1: fm row (video ext, pending_sidecar, NO elf/event) for a parseable root key
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state)
       VALUES ($1, 'recordings', $2, $3, 11111, 'pending_sidecar')`,
      [userId, s3Key, `Driveway_01_${ts}.mp4`],
    );

    const healed = await relinkUnlinkedFiles(10);

    expect(healed).toBe(1);

    // event exists (the zoom's own event id — no partner seeded)
    const expectedEventId = buildEventId(userUuid, ts, 'Driveway');
    const { rows: evRows } = await pool.query(
      `SELECT id FROM events WHERE id = $1`,
      [expectedEventId],
    );
    expect(evRows).toHaveLength(1);

    // elf row with view '01' exists
    const { rows: elfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1`,
      [expectedEventId],
    );
    expect(elfRows).toHaveLength(1);
    expect(elfRows[0].view_id).toBe('01');

    // fm is still pending_sidecar (completeUpload's attach path doesn't change state from pending_sidecar)
    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('pending_sidecar');

    // Seed 2: fm row with unparseable video name
    const s3KeyGarbage = `${userUuid}/garbage.mp4`;
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state)
       VALUES ($1, 'recordings', $2, 'garbage.mp4', 999, 'pending_sidecar')`,
      [userId, s3KeyGarbage],
    );

    const healed2 = await relinkUnlinkedFiles(10);
    // The already-healed row is now linked (elf exists) → NOT re-counted; only garbage row processed
    expect(healed2).toBe(0);

    // garbage fm → unrecognized (completeUpload's terminalState UPDATE)
    const { rows: garbageRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3KeyGarbage],
    );
    expect(garbageRows[0].processing_state).toBe('unrecognized');

    // no event for garbage
    const { rows: garbageEvRows } = await pool.query(
      `SELECT id FROM events WHERE owner_id = $1 AND id != $2`,
      [userId, expectedEventId],
    );
    expect(garbageEvRows).toHaveLength(0);
  });

  // ── Case 10: keeper-swap leaves partner alive when it retains a conflicting view (Fix B) ──

  it('case 10: keeper-swap leaves partner alive when it retains an UNCLASSIFIABLE conflicting view slot', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Fix B (fallback): keeper-swap nie może bezpiecznie rozwiązać kolizji gdy slot keepera trzyma plik NIEROZPOZNAWALNY (legacy debris bez parseowalnego tsRaw). Partner P (późniejszy ts, view {01}) + keeper K z view {00 (kanoniczny)} + {01 = debris niemożliwy do sklasyfikowania}. Upload wide 00 w tsK → branch 4c: K wykluczony z partner-search (ma 00), wybrany P; move P.01→K zablokowany; heal nie potrafi przenieść debris (nieparseowalny) ANI sklasyfikować że P.01 należy gdzie indziej → P musi przeżyć z view 01 (zachowanie historyczne + warn).');

    const tsK = '20260612160000'; // keeper timestamp (wide arrives at this ts)
    const tsP = addSecondsToTs(tsK, 14); // partner timestamp (later = P)
    const camera = 'Garden';

    const keeperId = buildEventId(userUuid, tsK, camera);
    const partnerId = buildEventId(userUuid, tsP, camera);
    expect(keeperId).not.toBe(partnerId);

    // events.timestamp must match parseTimestampEpoch's LOCAL-time bake (see
    // case 10a) so the seeded events fall inside the partner search window and
    // branch 4c is genuinely exercised.
    const iso = (ts: string) =>
      new Date(
        Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)),
        Number(ts.slice(8, 10)), Number(ts.slice(10, 12)), Number(ts.slice(12, 14)),
      ).toISOString();
    const dateOf = (ts: string) => `${ts.slice(0, 4)}/${ts.slice(4, 6)}/${ts.slice(6, 8)}`;

    // Insert partner P with view 01.
    await pool.query(
      `INSERT INTO events (id, camera, timestamp, date, owner_id) VALUES ($1, $2, $3, $4, $5)`,
      [partnerId, camera, iso(tsP), dateOf(tsP), userId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '01', $2)`,
      [partnerId, `${camera}_01_${tsP}.mp4`],
    );
    // Insert keeper K with its own canonical view 00 (so K is excluded from the
    // partner search → P is chosen → branch 4c) plus an UNCLASSIFIABLE legacy
    // debris file in the 01 slot (the conflicting slot the heal cannot resolve).
    await pool.query(
      `INSERT INTO events (id, camera, timestamp, date, owner_id) VALUES ($1, $2, $3, $4, $5)`,
      [keeperId, camera, iso(tsK), dateOf(tsK), userId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
      [keeperId, `${camera}_00_${tsK}.mp4`],
    );
    // K's 01 slot: a name with NO valid 14-digit timestamp → does NOT classify
    // under any profile → parseEventOf returns undefined → heal cannot re-home
    // it, so the keeper's occupant wins and P keeps its own (classifiable) view
    // as a standalone single-view event.
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '01', $2)`,
      [keeperId, `${camera}_01_legacydebris.mp4`],
    );

    // Now upload wide 00 at tsK — 14s EARLIER than P, so branch 4c fires:
    // K is inserted (ON CONFLICT DO NOTHING), move P.01→K is blocked (K.01
    // exists + unclassifiable), and the heal leaves P alive (fallback).
    const s3KeyWide = `${userUuid}/${camera}_00_${tsK}.mp4`;
    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3KeyWide,
      originalFilename: `${camera}_00_${tsK}.mp4`,
      fileSizeBytes: 20000,
    });

    // The wide file attaches to keeper K as view 00
    expect(result.state).toBe('pending_sidecar');
    expect((result as { eventId?: string }).eventId).toBe(keeperId);

    // Partner P must still exist (Fix B: not unconditionally deleted)
    const { rows: pRows } = await pool.query(
      `SELECT id FROM events WHERE id = $1`,
      [partnerId],
    );
    expect(pRows).toHaveLength(1);

    // Partner P still has its view 01 elf row
    const { rows: pElfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
      [partnerId],
    );
    expect(pElfRows.map((r: { view_id: string }) => r.view_id)).toEqual(['01']);

    // Keeper K has view 00 (new) AND view 01 (legacy — NOT overwritten)
    const { rows: kElfRows } = await pool.query(
      `SELECT view_id FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
      [keeperId],
    );
    expect(kElfRows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);
  });

  // ── Case 10a: keeper-swap HEALS a classifiable-artifact conflicting slot ──
  // The production Sentry signal "keeper-swap left partner <id> alive (it
  // retains a conflicting view slot)" fires on live Reolink dual-view cameras.
  // Unlike case 10 (unclassifiable legacy debris that genuinely can't be
  // resolved), the real production topology has a CLASSIFIABLE merge-artifact
  // occupying the keeper's view slot. The partner P chosen by
  // dualViewRecordingsMatch holds the legitimate sibling view, but the bulk
  // move is blocked by the artifact already sitting in K's slot, so the
  // intended dual-view merge silently fails and the user sees TWO events for
  // one scene (the keeper + an orphaned partner). The fix completes the merge:
  // it evicts the foreign-tsRaw artifact (re-homing it to its own standalone
  // event so the file is not lost), moves P's legitimate view into K, and
  // deletes the now-empty partner.
  it('case 10a (regression): keeper-swap heals a classifiable-artifact conflicting slot — partner merged, artifact re-homed', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Bug prod (Sentry "keeper-swap left partner alive"): kamera dual-view Reolink. Keeper K (tsK) trzyma view 01 będący artefaktem mergowania z OBCYM tsRaw (tsArtifact). Partner P (tsP, później) trzyma prawdziwy view 01. Upload wide 00 w tsK → branch 4c: move P.01→K zablokowany przez artefakt → przed fixem P zostaje żywy (dwa eventy na jedną scenę). Fix: artefakt zostaje przeniesiony do własnego standalone eventu, prawdziwy P.01 wchodzi do K, pusty P skasowany. Jeden event, oba widoki.');

    const tsK = '20260612170000';          // keeper / incoming wide timestamp
    const tsP = addSecondsToTs(tsK, 14);   // partner timestamp (later → P)
    const tsArtifact = addSecondsToTs(tsK, 2); // foreign-tsRaw artifact in K's 01 slot
    const camera = 'Patio';

    const keeperId = buildEventId(userUuid, tsK, camera);
    const partnerId = buildEventId(userUuid, tsP, camera);
    const artifactId = buildEventId(userUuid, tsArtifact, camera);
    expect(new Set([keeperId, partnerId, artifactId]).size).toBe(3); // all distinct

    // events.timestamp must match what completeUpload derives: buildEvents
    // runs the 14-digit tsRaw through parseTimestampEpoch, which constructs a
    // LOCAL-time Date (wall-clock baked as the host TZ) then toISOString()s it.
    // Seeding with a naive "...Z" string would land 1–2h off on a non-UTC dev
    // box and fall OUTSIDE the partner search window — which is exactly why the
    // pre-existing case 10 was passing without ever exercising branch 4c.
    const iso = (ts: string) =>
      new Date(
        Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)),
        Number(ts.slice(8, 10)), Number(ts.slice(10, 12)), Number(ts.slice(12, 14)),
      ).toISOString();
    const dateOf = (ts: string) => `${ts.slice(0, 4)}/${ts.slice(4, 6)}/${ts.slice(6, 8)}`;

    // Seed partner P (tsP) with the LEGITIMATE view 01.
    await pool.query(
      `INSERT INTO events (id, camera, timestamp, date, owner_id) VALUES ($1, $2, $3, $4, $5)`,
      [partnerId, camera, iso(tsP), dateOf(tsP), userId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '01', $2)`,
      [partnerId, `${camera}_01_${tsP}.mp4`],
    );
    // Seed keeper K (tsK) as a fully-merged dual-view event holding BOTH:
    //  - view 00: an earlier wide upload at tsK (its own canonical view), and
    //  - view 01: a CLASSIFIABLE merge artifact whose tsRaw (tsArtifact) ≠ K's
    //    id (an earlier proximity-merge pulled a foreign zoom into the slot).
    // Because K holds view 00 it is EXCLUDED from the incoming wide's disjoint
    // partner search (view overlap), so the search picks the LATER partner P
    // and branch 4c (keeper-swap, incoming earlier than partner) fires — the
    // exact path that emits the Sentry warn.
    await pool.query(
      `INSERT INTO events (id, camera, timestamp, date, owner_id) VALUES ($1, $2, $3, $4, $5)`,
      [keeperId, camera, iso(tsK), dateOf(tsK), userId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '00', $2)`,
      [keeperId, `${camera}_00_${tsK}.mp4`],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path) VALUES ($1, '01', $2)`,
      [keeperId, `${camera}_01_${tsArtifact}.mp4`],
    );

    // Upload the wide 00 at tsK — 14s EARLIER than P → branch 4c keeper-swap.
    const s3KeyWide = `${userUuid}/${camera}_00_${tsK}.mp4`;
    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key: s3KeyWide,
      originalFilename: `${camera}_00_${tsK}.mp4`,
      fileSizeBytes: 20000,
    });
    expect(result.state).toBe('pending_sidecar');
    expect((result as { eventId?: string }).eventId).toBe(keeperId);
    // The re-homed artifact's event is new and needs its own thumbnail job.
    expect((result as { rehomedEventIds?: string[] }).rehomedEventIds).toEqual([artifactId]);

    // HEAL: the partner is merged away — P no longer exists.
    const { rows: pRows } = await pool.query(`SELECT id FROM events WHERE id = $1`, [partnerId]);
    expect(pRows).toHaveLength(0);

    // Keeper K holds 00 (the wide) + 01 (the partner's LEGITIMATE path — the
    // foreign artifact was evicted from the slot).
    const { rows: kElf } = await pool.query(
      `SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1 ORDER BY view_id`,
      [keeperId],
    );
    expect(kElf.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);
    expect(kElf.find((r: { view_id: string }) => r.view_id === '01')!.video_rel_path).toBe(
      `${camera}_01_${tsP}.mp4`,
    );

    // The displaced artifact is NOT lost — it is re-homed to its own
    // standalone event (id derived from its own tsRaw).
    const { rows: artElf } = await pool.query(
      `SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1`,
      [artifactId],
    );
    expect(artElf).toHaveLength(1);
    expect(artElf[0].view_id).toBe('01');
    expect(artElf[0].video_rel_path).toBe(`${camera}_01_${tsArtifact}.mp4`);

    // Exactly two events for this camera now: the merged keeper + the
    // standalone re-homed artifact. No orphaned partner.
    const { rows: evCount } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE owner_id = $1 AND camera = $2`,
      [userId, camera],
    );
    expect(evCount[0].n).toBe(2);
  });

  // ── Case 11: dual-lens merge artifact healed, NOT flagged as duplicate ────

  it('case 11: legit zoom arriving after a merge artifact heals the slot, no duplicate', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Regresja duplicate-file: wide 12:00:00 + zoom 12:00:02 mergują się (artefakt); później przychodzi prawdziwy zoom 12:00:00 — to NIE duplikat, slot się leczy do 12:00:00, a artefakt 12:00:02 staje się osobnym eventem standalone. Brak notyfikacji duplicate_file.');

    const tsWide = '20260418120000';            // wide 12:00:00
    const tsZoomArtifact = addSecondsToTs(tsWide, 2); // zoom 12:00:02 — merges into wide via 30s fallback
    const camera = 'MergeArt';
    const wideEventId = buildEventId(userUuid, tsWide, camera);
    const artifactEventId = buildEventId(userUuid, tsZoomArtifact, camera);

    const s3Wide = `${userUuid}/2026/04/18/${camera}_00_${tsWide}.mp4`;
    const s3ZoomArtifact = `${userUuid}/2026/04/18/${camera}_01_${tsZoomArtifact}.mp4`;
    const s3ZoomReal = `${userUuid}/2026/04/18/${camera}_01_${tsWide}.mp4`;

    // Step A: wide then artifact-zoom → merged event (wide id), view 01 = artifact.
    await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: s3Wide, originalFilename: `${camera}_00_${tsWide}.mp4`, fileSizeBytes: 1000 });
    const rArtifact = await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: s3ZoomArtifact, originalFilename: `${camera}_01_${tsZoomArtifact}.mp4`, fileSizeBytes: 1000 });
    expect((rArtifact as { eventId?: string }).eventId).toBe(wideEventId); // merged into wide
    {
      const { rows } = await pool.query(`SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1 ORDER BY view_id`, [wideEventId]);
      expect(rows.map((r: { view_id: string }) => r.view_id)).toEqual(['00', '01']);
      expect(rows.find((r: { view_id: string }) => r.view_id === '01')!.video_rel_path).toBe(`2026/04/18/${camera}_01_${tsZoomArtifact}.mp4`);
    }

    // Step B: the legit zoom at the wide's exact ts → must HEAL, not duplicate.
    const rReal = await completeUpload({ userId, userUuid, s3Bucket: 'recordings', s3Key: s3ZoomReal, originalFilename: `${camera}_01_${tsWide}.mp4`, fileSizeBytes: 1000 });
    expect(rReal.state).toBe('pending_sidecar'); // NOT 'duplicate'
    expect((rReal as { eventId?: string }).eventId).toBe(wideEventId);
    // The re-homed artifact's event is new and never got a thumbnail job
    // before this fix. The caller learns its id from here.
    expect((rReal as { rehomedEventIds?: string[] }).rehomedEventIds).toEqual([artifactEventId]);
    // Plain merges/links report nothing re-homed.
    expect((rArtifact as { rehomedEventIds?: string[] }).rehomedEventIds).toBeUndefined();

    // Wide event's view 01 slot now points at the REAL zoom (healed).
    {
      const { rows } = await pool.query(`SELECT video_rel_path FROM event_view_files WHERE event_id = $1 AND view_id = '01'`, [wideEventId]);
      expect(rows[0].video_rel_path).toBe(`2026/04/18/${camera}_01_${tsWide}.mp4`);
    }
    // The displaced artifact is re-homed as its own standalone event (view 01).
    {
      const { rows } = await pool.query(`SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = $1`, [artifactEventId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].view_id).toBe('01');
      expect(rows[0].video_rel_path).toBe(`2026/04/18/${camera}_01_${tsZoomArtifact}.mp4`);
    }
    // No duplicate_file notification was emitted, and the real zoom is not tombstoned.
    const { rows: notif } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'duplicate_file'`, [userId]);
    expect(notif[0].n).toBe(0);
    const { rows: fm } = await pool.query(`SELECT processing_state FROM file_metadata WHERE s3_key = $1`, [s3ZoomReal]);
    expect(fm[0].processing_state).toBe('pending_sidecar');

    // Redrive safety net: the re-homed event has never had a thumbnail job,
    // so the missing-thumbnail sweep must pick it up…
    const missingIds = async () => (await getEventsMissingThumbnail(10_000)).map((e) => e.id);
    expect(await missingIds()).toContain(artifactEventId);
    // …but stop once the worker has taken it (it owns retries from there),
    await pool.query(`UPDATE events SET thumbnail_attempts = 1 WHERE id = $1`, [artifactEventId]);
    expect(await missingIds()).not.toContain(artifactEventId);
    // and never chase a tombstoned event, whose thumbnail stays NULL for good.
    await pool.query(`UPDATE events SET thumbnail_attempts = 0, playback_unplayable = TRUE WHERE id = $1`, [artifactEventId]);
    expect(await missingIds()).not.toContain(artifactEventId);
  });

  // ── R1 path: every video → pending_sidecar (R2c inline path removed) ────────

  it('R1 path: recognised video → pending_sidecar (TS worker builds sidecars)', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'R1: po completeUpload plik wideo dostaje processing_state=pending_sidecar; worker buduje sidecary off-path.');

    const ts = '20260614100000';
    const s3Key = `${userUuid}/Driveway_00_${ts}.mp4`;
    const expectedEventId = buildEventId(userUuid, ts, 'Driveway');

    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
    });

    expect(result.created).toBe(true);
    expect(result.state).toBe('pending_sidecar');
    expect((result as { eventId?: string }).eventId).toBe(expectedEventId);

    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('pending_sidecar');

    const { rows: evRows } = await pool.query(
      `SELECT playback_ready FROM events WHERE id = $1`,
      [expectedEventId],
    );
    expect(evRows[0].playback_ready).toBe(false);
  });

  // ── R1 path: absent inlineAnalysis → pending_sidecar ────────────────────

  it('R1 path: absent inlineAnalysis parameter → pending_sidecar unchanged', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'R1: brak inlineAnalysis. Zachowanie identyczne z R1: pending_sidecar.');

    const ts = '20260614104000';
    const s3Key = `${userUuid}/Driveway_00_${ts}.mp4`;

    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: `Driveway_00_${ts}.mp4`,
      fileSizeBytes: 12345,
      // No inlineAnalysis
    });

    expect(result.state).toBe('pending_sidecar');

    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('pending_sidecar');
  });

  // ── Custom camera-profile mode (regression 2026-06-22) ──────────────────
  // R3 deleted the scanner's vetUntrustedProfiles step, so the synchronous
  // ingest path skipped every (untrusted) custom profile in classifyFilename
  // → EVERY upload from a custom-mode user was classified 'unrecognized'
  // (no event, no processing banner). getEffectiveProfiles now re-vets.

  const REOLINK_RE =
    '^(?<camera>.+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4|m4v|mov|mkv|webm|avi|ts|3gp|jpg|jpeg|png)$';

  async function makeUserCustom(reolinkRegex = REOLINK_RE): Promise<void> {
    await pool.query(`UPDATE users SET camera_profile_mode = 'custom' WHERE id = $1`, [userId]);
    await pool.query(
      `INSERT INTO user_camera_profiles (user_id, name, regex, view_default, views_config, priority, enabled)
       VALUES ($1, 'Reolink', $2, '00', '[{"id":"00","iconKind":"wide"},{"id":"01","iconKind":"zoom"}]'::jsonb, 10, true)`,
      [userId, reolinkRegex],
    );
  }

  it('custom mode (regression): a matching upload creates an event, NOT unrecognized', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Regresja 2026-06-22 (jedno konto): w trybie custom każdy upload pasujący do profilu lądował jako processing_state=unrecognized (brak eventu, brak bannera) bo classifyFilename pomija nie-zwery­fikowane profile. Po przywróceniu vettingu w getEffectiveProfiles pasujący plik tworzy event.');
    await makeUserCustom();

    const ts = '20260622094644';
    const s3Key = `${userUuid}/Driveway_01_${ts}.mp4`;
    const expectedEventId = buildEventId(userUuid, ts, 'Driveway');

    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: `Driveway_01_${ts}.mp4`,
      fileSizeBytes: 22222,
    });

    // Before the fix this was { state: 'unrecognized' } with zero event rows.
    expect(result.state).toBe('pending_sidecar');
    expect((result as { eventId?: string }).eventId).toBe(expectedEventId);

    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(1);

    const { rows: fmRows } = await pool.query(
      `SELECT processing_state FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    expect(fmRows[0].processing_state).toBe('pending_sidecar');
  });

  it('custom mode: a file matching NO custom profile is still unrecognized (no over-correction)', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Strażnik przeciw nad-korekcie: w trybie custom plik, który NIE pasuje do żadnego profilu, dalej musi być unrecognized (brak eventu). Fix odblokowuje tylko pasujące pliki.');
    await makeUserCustom();

    const s3Key = `${userUuid}/IPCamera_garbagename.mp4`; // no _00_/_01_ view segment

    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: 'IPCamera_garbagename.mp4',
      fileSizeBytes: 999,
    });

    expect(result.state).toBe('unrecognized');
    const { rows: evRows } = await pool.query(`SELECT id FROM events WHERE owner_id = $1`, [userId]);
    expect(evRows).toHaveLength(0);
  });

  it('unrecognized first-ingest gets a next_retry_at so redrive can retry it (R1 guard-bug fix)', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Bug R1 (guard za szeroki): plik nierozpoznany przy PIERWSZYM ingest dostawał next_retry_at=NULL — UPDATE miał guard `processing_state NOT IN (ready, unrecognized)`, a wiersz był właśnie wstawiony jako unrecognized, więc UPDATE go pomijał → redrive NIGDY go nie ponawiał (stuck-forever, dokładnie jak 194 pliki user 22 2026-06-22). Po zwężeniu guardu do `<> ready` pierwszy ingest ustawia next_retry_at, więc redrive może ponowić (np. gdy user doda pasujący profil).');
    // The seeded user is mode='auto' → GLOBAL_CAMERA_PROFILES; this name matches none.
    const s3Key = `${userUuid}/garbage.mp4`;
    const result = await completeUpload({
      userId,
      userUuid,
      s3Bucket: 'recordings',
      s3Key,
      originalFilename: 'garbage.mp4',
      fileSizeBytes: 123,
    });

    expect(result.state).toBe('unrecognized');
    const { rows } = await pool.query(
      `SELECT next_retry_at FROM file_metadata WHERE s3_key = $1`,
      [s3Key],
    );
    // Before the fix this was NULL → the row was invisible to redrive forever.
    expect(rows[0].next_retry_at).not.toBeNull();
  });
});
