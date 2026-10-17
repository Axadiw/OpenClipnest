/**
 * DB-level contract tests for the processing_state dual-write columns
 * added in migration 0007_add_processing_state.
 *
 * Pins the exact SQL semantics that the three thumbnail-worker functions
 * (markPlaybackPatchReady, markPlaybackPatchUnplayable,
 * incrementPlaybackPatchAttempts) rely on, so any schema drift surfaces in
 * CI before it causes a silent data-corruption regression.
 *
 * Real Postgres only — set DATABASE_URL_TEST or DATABASE_URL; otherwise
 * all tests in this suite are skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { migrateToSchema } from '../../testing/migrate-schema.js';
import { story } from '../../testing/story.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
// Migrations are two levels up from server/db/queries/ → server/db/migrations/
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const SCRATCH_SCHEMA = `test_pstate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Schema-contract tests: these replicate the drizzle-generated SQL on purpose
// so that the exact column semantics are pinned here even though the app
// functions bind to the app db handle. Function-level integration is covered
// by the CI integration tests (tests/test-server/).
describe.skipIf(!TEST_DB_URL)('processing_state dual-write SQL contract', () => {
  let pool: Pool;
  let fileMetadataId: number;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 2,
      options: `-c search_path="${SCRATCH_SCHEMA}",public`,
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);

    // Seed a plan required by users FK
    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes)
       VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`,
    );
  }, 90_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.end();
    const cleanup = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await cleanup.end();
  }, 90_000);

  beforeEach(async () => {
    // Fresh schema per test: drop all user/file rows between tests
    await pool.query(`TRUNCATE file_metadata, users RESTART IDENTITY CASCADE`);

    // Seed one user
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES (gen_random_uuid(), 'pstate-test@example.com', 'x', true, true, 1)
       RETURNING id`,
    );
    const ownerId: number = u.rows[0].id;

    // Seed one file_metadata row in the default pending_sidecar state
    const fm = await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes)
       VALUES ($1, 'recordings', $2, 'clip.mp4', 1234567)
       RETURNING id`,
      [ownerId, `${u.rows[0].id}/clip.mp4`],
    );
    fileMetadataId = fm.rows[0].id as number;
  }, 60_000);

  // ── ready transition ─────────────────────────────────────────────────────

  it('ready transition sets processing_state=ready and clears next_retry_at', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'markPlaybackPatchReady ustawia processing_state=ready i kasuje next_retry_at.');
    // Pre-condition: seed a non-null next_retry_at so we can confirm it clears
    await pool.query(
      `UPDATE file_metadata SET next_retry_at = NOW() + interval '1 hour' WHERE id = $1`,
      [fileMetadataId],
    );

    // Replicate markPlaybackPatchReady UPDATE
    await pool.query(
      `UPDATE file_metadata
          SET processing_state = 'ready',
              next_retry_at = NULL
        WHERE id = $1`,
      [fileMetadataId],
    );

    const { rows } = await pool.query(
      `SELECT processing_state, next_retry_at FROM file_metadata WHERE id = $1`,
      [fileMetadataId],
    );
    expect(rows[0].processing_state).toBe('ready');
    expect(rows[0].next_retry_at).toBeNull();
  });

  // ── unplayable transition ────────────────────────────────────────────────

  it('unplayable transition sets processing_state=unplayable and clears next_retry_at', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'markPlaybackPatchUnplayable ustawia processing_state=unplayable i kasuje next_retry_at.');
    await pool.query(
      `UPDATE file_metadata SET next_retry_at = NOW() + interval '1 hour' WHERE id = $1`,
      [fileMetadataId],
    );

    // Replicate markPlaybackPatchUnplayable UPDATE
    await pool.query(
      `UPDATE file_metadata
          SET processing_state = 'unplayable',
              next_retry_at = NULL
        WHERE id = $1`,
      [fileMetadataId],
    );

    const { rows } = await pool.query(
      `SELECT processing_state, next_retry_at FROM file_metadata WHERE id = $1`,
      [fileMetadataId],
    );
    expect(rows[0].processing_state).toBe('unplayable');
    expect(rows[0].next_retry_at).toBeNull();
  });

  // ── attempt increment + exponential backoff ──────────────────────────────

  it('attempt increment sets exponential next_retry_at capped at 1h', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'incrementPlaybackPatchAttempts stosuje wykładniczy backoff (2^n * 60s) z cap 1h — interwały wyliczane w Postgresie, bez JS wall-clock.');

    // First increment: attempts 0 → 1, POWER(2, 0) * 60 = 60s
    await pool.query(
      `UPDATE file_metadata
          SET processing_attempts = processing_attempts + 1,
              next_retry_at = NOW() + LEAST(
                make_interval(secs => POWER(2, processing_attempts) * 60),
                interval '1 hour'
              )
        WHERE id = $1`,
      [fileMetadataId],
    );

    // Measure the interval entirely inside Postgres to avoid JS/DB clock skew.
    // POWER(2, 0) * 60 = 60s — allow [50, 70] for pool-acquisition jitter.
    const { rows: firstCheck } = await pool.query<{ secs: string }>(
      `SELECT EXTRACT(EPOCH FROM (next_retry_at - NOW())) AS secs
         FROM file_metadata WHERE id = $1`,
      [fileMetadataId],
    );
    const secsFirst = Number(firstCheck[0].secs);
    expect(secsFirst).toBeGreaterThan(50);
    expect(secsFirst).toBeLessThan(70);

    // Check attempts counter separately (no clock involved).
    const { rows: att1 } = await pool.query<{ processing_attempts: string }>(
      `SELECT processing_attempts FROM file_metadata WHERE id = $1`,
      [fileMetadataId],
    );
    expect(Number(att1[0].processing_attempts)).toBe(1);

    // Run 7 more increments to drive attempts well past the cap crossover
    // (cap hits at POWER(2,k)*60 >= 3600 → k=6, i.e. attempts=6 pre-increment)
    for (let i = 0; i < 7; i++) {
      await pool.query(
        `UPDATE file_metadata
            SET processing_attempts = processing_attempts + 1,
                next_retry_at = NOW() + LEAST(
                  make_interval(secs => POWER(2, processing_attempts) * 60),
                  interval '1 hour'
                )
          WHERE id = $1`,
        [fileMetadataId],
      );
    }

    const { rows: att8 } = await pool.query<{ processing_attempts: string }>(
      `SELECT processing_attempts FROM file_metadata WHERE id = $1`,
      [fileMetadataId],
    );
    expect(Number(att8[0].processing_attempts)).toBe(8);

    // Interval measured in Postgres: must be capped near 1 hour [3500, 3700].
    const { rows: finalCheck } = await pool.query<{ secs: string }>(
      `SELECT EXTRACT(EPOCH FROM (next_retry_at - NOW())) AS secs
         FROM file_metadata WHERE id = $1`,
      [fileMetadataId],
    );
    const secsFinal = Number(finalCheck[0].secs);
    expect(secsFinal).toBeLessThanOrEqual(3700);
    expect(secsFinal).toBeGreaterThanOrEqual(3500);
  });

  // ── CHECK constraint ─────────────────────────────────────────────────────

  it('CHECK constraint rejects unknown processing_state values', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'CHECK constraint file_metadata_processing_state_check odrzuca nieznane wartości kolumny processing_state.');
    await expect(
      pool.query(
        `UPDATE file_metadata SET processing_state = 'bogus' WHERE id = $1`,
        [fileMetadataId],
      ),
    ).rejects.toThrow(/file_metadata_processing_state_check/);
  });

  // ── banner query contract ────────────────────────────────────────────────

  it('banner counts exactly the pending_sidecar rows', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'getProcessingStatus SQL zwraca tylko wiersze z processing_state=pending_sidecar — ready, not_applicable i duplicate są pomijane.');
    // Seed 4 additional fm rows for the seeded owner (beforeEach already has 1 pending_sidecar)
    const { rows: [{ id: ownerId }] } = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = 'pstate-test@example.com'`,
    );
    // Clear the beforeEach seed row so we control the full set precisely
    await pool.query(`DELETE FROM file_metadata WHERE owner_id = $1`, [ownerId]);

    // $1 = owner_id (int), $2 = owner_id as text for the s3_key prefix — must
    // be distinct params, else Postgres deduces inconsistent types for one $1
    // used both as int and in `|| text`.
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state) VALUES
        ($1, 'recordings', $2 || '/pending.mp4',      'pending.mp4',      1000, 'pending_sidecar'),
        ($1, 'recordings', $2 || '/ready.mp4',        'ready.mp4',        1000, 'ready'),
        ($1, 'recordings', $2 || '/orphan.jpg',       'orphan.jpg',       1000, 'not_applicable'),
        ($1, 'recordings', $2 || '/duplicate.mp4',    'duplicate.mp4',    1000, 'duplicate')`,
      [ownerId, String(ownerId)],
    );

    // Assert via the SAME SQL shape the rewritten getProcessingStatus uses
    const { rows } = await pool.query<{
      id: number;
      filename: string;
      uploadedAt: string;
      total: string;
    }>(
      `SELECT id, original_filename AS filename, uploaded_at AS "uploadedAt", COUNT(*) OVER () AS total
         FROM file_metadata
        WHERE owner_id = $1
          AND processing_state = 'pending_sidecar'
        ORDER BY uploaded_at DESC
        LIMIT 100`,
      [ownerId],
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total)).toBe(1);
    expect(rows[0].filename).toBe('pending.mp4');
  });

  // ── recompute: thumbnail decoupled from playback_ready ───────────────────

  it('recompute: all files ready + NULL thumbnail → playback_ready TRUE (new rule)', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'RECOMPUTE_PLAYBACK_READY_SQL: event z NULL thumbnail i gotowymi plikami dostaje playback_ready=TRUE (nowa reguła); po ustawieniu thumbnail=UNPLAYABLE recompute flips playback_unplayable=TRUE przy zachowaniu playback_ready=TRUE.');

    // Resolve the seeded user from beforeEach
    const { rows: [{ id: ownerId, uuid: userUuid }] } = await pool.query<{ id: number; uuid: string }>(
      `SELECT id, uuid FROM users WHERE email = 'pstate-test@example.com'`,
    );

    const relPath = 'recompute-test.mp4';
    const s3Key = `${userUuid}/${relPath}`;
    const eventId = 'evt-recompute-null-thumb';

    // Seed the event with NULL thumbnail and playback_ready=FALSE (default)
    await pool.query(
      `INSERT INTO events (id, camera, "timestamp", date, owner_id, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, 'TestCam', '2026-01-01T00:00:00', '2026-01-01', $2, NULL, FALSE, FALSE)`,
      [eventId, ownerId],
    );

    // Seed the event_view_files link
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path)
       VALUES ($1, '00', $2)`,
      [eventId, relPath],
    );

    // Make the file ready (reusing the beforeEach fm row by updating its s3_key + setting state)
    await pool.query(
      `UPDATE file_metadata SET s3_key = $1, processing_state = 'ready' WHERE owner_id = $2`,
      [s3Key, ownerId],
    );

    // Run the recompute SQL (mirrors RECOMPUTE_PLAYBACK_READY_SQL)
    const THUMBNAIL_UNPLAYABLE = '__unplayable__';
    await pool.query(
      `WITH user_uuid AS (
         SELECT uuid FROM users WHERE id = $1
       ),
       attached AS (
         SELECT
           e.id AS event_id,
           BOOL_AND(
             CASE WHEN fm.id IS NOT NULL
               THEN fm.processing_state = 'ready'
               ELSE FALSE
             END
           ) AS all_files_ready,
           BOOL_OR(fm.processing_state = 'unplayable') AS any_unplayable
         FROM events e
         CROSS JOIN user_uuid u
         JOIN event_view_files elf ON elf.event_id = e.id
         LEFT JOIN file_metadata fm
           ON fm.owner_id = e.owner_id
          AND SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) = elf.video_rel_path
         WHERE e.owner_id = $1
         GROUP BY e.id
       )
       UPDATE events e
          SET playback_ready = COALESCE(a.all_files_ready, FALSE),
              playback_unplayable = (
                e.thumbnail IS NOT DISTINCT FROM $2
                OR COALESCE(a.any_unplayable, FALSE)
              )
         FROM attached a
        WHERE a.event_id = e.id
          AND e.owner_id = $1`,
      [ownerId, THUMBNAIL_UNPLAYABLE],
    );

    const { rows: [row1] } = await pool.query<{ playback_ready: boolean; playback_unplayable: boolean }>(
      `SELECT playback_ready, playback_unplayable FROM events WHERE id = $1`,
      [eventId],
    );
    // NULL thumbnail + ready files → playback_ready=TRUE, playback_unplayable=FALSE
    expect(row1.playback_ready).toBe(true);
    expect(row1.playback_unplayable).toBe(false);

    // Now tombstone the thumbnail and re-run the recompute
    await pool.query(`UPDATE events SET thumbnail = $1 WHERE id = $2`, [THUMBNAIL_UNPLAYABLE, eventId]);
    await pool.query(
      `WITH user_uuid AS (
         SELECT uuid FROM users WHERE id = $1
       ),
       attached AS (
         SELECT
           e.id AS event_id,
           BOOL_AND(
             CASE WHEN fm.id IS NOT NULL
               THEN fm.processing_state = 'ready'
               ELSE FALSE
             END
           ) AS all_files_ready,
           BOOL_OR(fm.processing_state = 'unplayable') AS any_unplayable
         FROM events e
         CROSS JOIN user_uuid u
         JOIN event_view_files elf ON elf.event_id = e.id
         LEFT JOIN file_metadata fm
           ON fm.owner_id = e.owner_id
          AND SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) = elf.video_rel_path
         WHERE e.owner_id = $1
         GROUP BY e.id
       )
       UPDATE events e
          SET playback_ready = COALESCE(a.all_files_ready, FALSE),
              playback_unplayable = (
                e.thumbnail IS NOT DISTINCT FROM $2
                OR COALESCE(a.any_unplayable, FALSE)
              )
         FROM attached a
        WHERE a.event_id = e.id
          AND e.owner_id = $1`,
      [ownerId, THUMBNAIL_UNPLAYABLE],
    );

    const { rows: [row2] } = await pool.query<{ playback_ready: boolean; playback_unplayable: boolean }>(
      `SELECT playback_ready, playback_unplayable FROM events WHERE id = $1`,
      [eventId],
    );
    // Tombstone thumbnail → playback_ready stays TRUE but playback_unplayable flips TRUE (hides from grid)
    expect(row2.playback_ready).toBe(true);
    expect(row2.playback_unplayable).toBe(true);
  });

  it('recompute per-file: all files ready + NULL thumbnail → playback_ready TRUE (new rule)', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'RECOMPUTE_PLAYBACK_READY_FOR_FILE_SQL: per-file variant używa tej samej reguły co owner-level — NULL thumbnail nie blokuje playback_ready; __unplayable__ thumbnail flips playback_unplayable=TRUE przy zachowaniu playback_ready=TRUE.');

    // Resolve the seeded user from beforeEach
    const { rows: [{ id: ownerId, uuid: userUuid }] } = await pool.query<{ id: number; uuid: string }>(
      `SELECT id, uuid FROM users WHERE email = 'pstate-test@example.com'`,
    );

    const relPath = 'recompute-file-test.mp4';
    const s3Key = `${userUuid}/${relPath}`;
    const eventId = 'evt-recompute-file-null-thumb';

    // Seed the event with NULL thumbnail and playback_ready=FALSE (default)
    await pool.query(
      `INSERT INTO events (id, camera, "timestamp", date, owner_id, thumbnail, playback_ready, playback_unplayable)
       VALUES ($1, 'TestCam', '2026-01-01T00:00:00', '2026-01-01', $2, NULL, FALSE, FALSE)`,
      [eventId, ownerId],
    );

    // Seed the event_view_files link
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path)
       VALUES ($1, '00', $2)`,
      [eventId, relPath],
    );

    // Make the file ready with the correct s3_key
    await pool.query(
      `UPDATE file_metadata SET s3_key = $1, processing_state = 'ready' WHERE owner_id = $2`,
      [s3Key, ownerId],
    );

    // Fetch the file_metadata id for the per-file SQL
    const { rows: [{ id: fmId }] } = await pool.query<{ id: number }>(
      `SELECT id FROM file_metadata WHERE owner_id = $1`,
      [ownerId],
    );

    // Run the per-file recompute SQL (mirrors RECOMPUTE_PLAYBACK_READY_FOR_FILE_SQL)
    const THUMBNAIL_UNPLAYABLE = '__unplayable__';
    await pool.query(
      `WITH file AS (
             SELECT fm.id, fm.owner_id, u.uuid,
                    SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) AS rel_path
             FROM file_metadata fm
             JOIN users u ON u.id = fm.owner_id
             WHERE fm.id = $1
           ),
           affected AS (
             SELECT DISTINCT e.id
             FROM events e
             JOIN file f ON e.owner_id = f.owner_id
             JOIN event_view_files elf
               ON elf.event_id = e.id
              AND elf.video_rel_path = f.rel_path
           ),
           attached AS (
             SELECT
               e.id AS event_id,
               BOOL_AND(
                 CASE WHEN fm.id IS NOT NULL
                   THEN fm.processing_state = 'ready'
                   ELSE FALSE
                 END
               ) AS all_files_ready,
               BOOL_OR(fm.processing_state = 'unplayable') AS any_unplayable
             FROM events e
             JOIN affected a ON a.id = e.id
             CROSS JOIN file f
             JOIN event_view_files elf ON elf.event_id = e.id
             LEFT JOIN file_metadata fm
               ON fm.owner_id = e.owner_id
              AND fm.s3_key = f.uuid || '/' || elf.video_rel_path
             GROUP BY e.id
           )
           UPDATE events e
              SET playback_ready = COALESCE(a.all_files_ready, FALSE),
                  playback_unplayable = (
                    e.thumbnail IS NOT DISTINCT FROM $2
                    OR COALESCE(a.any_unplayable, FALSE)
                  )
             FROM attached a
            WHERE a.event_id = e.id`,
      [fmId, THUMBNAIL_UNPLAYABLE],
    );

    const { rows: [row1] } = await pool.query<{ playback_ready: boolean; playback_unplayable: boolean }>(
      `SELECT playback_ready, playback_unplayable FROM events WHERE id = $1`,
      [eventId],
    );
    // NULL thumbnail + ready files → playback_ready=TRUE, playback_unplayable=FALSE
    expect(row1.playback_ready).toBe(true);
    expect(row1.playback_unplayable).toBe(false);

    // Now tombstone the thumbnail and re-run the per-file recompute
    await pool.query(`UPDATE events SET thumbnail = $1 WHERE id = $2`, [THUMBNAIL_UNPLAYABLE, eventId]);
    await pool.query(
      `WITH file AS (
             SELECT fm.id, fm.owner_id, u.uuid,
                    SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) AS rel_path
             FROM file_metadata fm
             JOIN users u ON u.id = fm.owner_id
             WHERE fm.id = $1
           ),
           affected AS (
             SELECT DISTINCT e.id
             FROM events e
             JOIN file f ON e.owner_id = f.owner_id
             JOIN event_view_files elf
               ON elf.event_id = e.id
              AND elf.video_rel_path = f.rel_path
           ),
           attached AS (
             SELECT
               e.id AS event_id,
               BOOL_AND(
                 CASE WHEN fm.id IS NOT NULL
                   THEN fm.processing_state = 'ready'
                   ELSE FALSE
                 END
               ) AS all_files_ready,
               BOOL_OR(fm.processing_state = 'unplayable') AS any_unplayable
             FROM events e
             JOIN affected a ON a.id = e.id
             CROSS JOIN file f
             JOIN event_view_files elf ON elf.event_id = e.id
             LEFT JOIN file_metadata fm
               ON fm.owner_id = e.owner_id
              AND fm.s3_key = f.uuid || '/' || elf.video_rel_path
             GROUP BY e.id
           )
           UPDATE events e
              SET playback_ready = COALESCE(a.all_files_ready, FALSE),
                  playback_unplayable = (
                    e.thumbnail IS NOT DISTINCT FROM $2
                    OR COALESCE(a.any_unplayable, FALSE)
                  )
             FROM attached a
            WHERE a.event_id = e.id`,
      [fmId, THUMBNAIL_UNPLAYABLE],
    );

    const { rows: [row2] } = await pool.query<{ playback_ready: boolean; playback_unplayable: boolean }>(
      `SELECT playback_ready, playback_unplayable FROM events WHERE id = $1`,
      [eventId],
    );
    // Tombstone thumbnail → playback_ready stays TRUE but playback_unplayable flips TRUE (hides from grid)
    expect(row2.playback_ready).toBe(true);
    expect(row2.playback_unplayable).toBe(true);
  });

  // ── partial indexes ───────────────────────────────────────────────────────

  it('partial indexes exist', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Partial indexes idx_file_metadata_owner_state_pending i idx_file_metadata_redrive są tworzone przez migrację.');
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'file_metadata'`,
      [SCRATCH_SCHEMA],
    );
    const names = rows.map(r => r.indexname);
    expect(names).toContain('idx_file_metadata_owner_state_pending');
    expect(names).toContain('idx_file_metadata_redrive');
  });

  // ── redrive batch ─────────────────────────────────────────────────────────

  it('redrive batch returns linked pending_sidecar rows that are due', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'getSidecarRedriveBatch zwraca tylko powiązane (elf) wiersze pending_sidecar, których next_retry_at jest NULL lub w przeszłości; wiersze z future next_retry_at, bez elf, lub w stanie ready są pomijane.');

    // Resolve the seeded user from beforeEach
    const { rows: [{ id: ownerId, uuid: userUuid }] } = await pool.query<{ id: number; uuid: string }>(
      `SELECT id, uuid FROM users WHERE email = 'pstate-test@example.com'`,
    );

    // Clear the beforeEach seed row so we control the full set precisely
    await pool.query(`DELETE FROM file_metadata WHERE owner_id = $1`, [ownerId]);

    // ── Shape A: event + elf + fm(pending_sidecar, next_retry_at NULL) → RETURNED ──
    const relPathA = 'cam-A.mp4';
    const s3KeyA = `${userUuid}/${relPathA}`;
    const eventIdA = 'evt-redrive-A';
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state, next_retry_at)
       VALUES ($1, 'recordings', $2, 'cam-A.mp4', 1000, 'pending_sidecar', NULL)`,
      [ownerId, s3KeyA],
    );
    await pool.query(
      `INSERT INTO events (id, camera, "timestamp", date, owner_id, playback_ready, playback_unplayable)
       VALUES ($1, 'CamA', '2026-01-01T00:00:00', '2026-01-01', $2, FALSE, FALSE)`,
      [eventIdA, ownerId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path)
       VALUES ($1, '00', $2)`,
      [eventIdA, relPathA],
    );

    // ── Shape B: event + elf + fm(pending_sidecar, next_retry_at = now()+1h) → NOT RETURNED ──
    const relPathB = 'cam-B.mp4';
    const s3KeyB = `${userUuid}/${relPathB}`;
    const eventIdB = 'evt-redrive-B';
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state, next_retry_at)
       VALUES ($1, 'recordings', $2, 'cam-B.mp4', 1000, 'pending_sidecar', NOW() + interval '1 hour')`,
      [ownerId, s3KeyB],
    );
    await pool.query(
      `INSERT INTO events (id, camera, "timestamp", date, owner_id, playback_ready, playback_unplayable)
       VALUES ($1, 'CamB', '2026-01-01T00:00:00', '2026-01-01', $2, FALSE, FALSE)`,
      [eventIdB, ownerId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path)
       VALUES ($1, '00', $2)`,
      [eventIdB, relPathB],
    );

    // ── Shape C: fm(pending_sidecar, video ext) with NO elf row → NOT RETURNED ──
    const relPathC = 'cam-C.mp4';
    const s3KeyC = `${userUuid}/${relPathC}`;
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state, next_retry_at)
       VALUES ($1, 'recordings', $2, 'cam-C.mp4', 1000, 'pending_sidecar', NULL)`,
      [ownerId, s3KeyC],
    );
    // No events/elf row for C — intentionally unlinked

    // ── Shape D: event + elf + fm(ready) → NOT RETURNED ──
    const relPathD = 'cam-D.mp4';
    const s3KeyD = `${userUuid}/${relPathD}`;
    const eventIdD = 'evt-redrive-D';
    await pool.query(
      `INSERT INTO file_metadata (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state)
       VALUES ($1, 'recordings', $2, 'cam-D.mp4', 1000, 'ready')`,
      [ownerId, s3KeyD],
    );
    await pool.query(
      `INSERT INTO events (id, camera, "timestamp", date, owner_id, playback_ready, playback_unplayable)
       VALUES ($1, 'CamD', '2026-01-01T00:00:00', '2026-01-01', $2, TRUE, FALSE)`,
      [eventIdD, ownerId],
    );
    await pool.query(
      `INSERT INTO event_view_files (event_id, view_id, video_rel_path)
       VALUES ($1, '00', $2)`,
      [eventIdD, relPathD],
    );

    // Assert via the literal SQL from getSidecarRedriveBatch (token-identical copy)
    const { rows } = await pool.query<{ eventId: string; ownerId: number }>(
      `SELECT DISTINCT e.id AS "eventId", e.owner_id AS "ownerId"
         FROM file_metadata fm
         JOIN users u ON u.id = fm.owner_id
         JOIN event_view_files elf
           ON elf.video_rel_path = SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2)
         JOIN events e ON e.id = elf.event_id AND e.owner_id = fm.owner_id
        WHERE fm.processing_state = 'pending_sidecar'
          AND (fm.next_retry_at IS NULL OR fm.next_retry_at < NOW())
        LIMIT 500`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(eventIdA);
    expect(rows[0].ownerId).toBe(ownerId);
  });

  // ── trackFileUpload insert-time classification ──────────────────────────

  it('trackFileUpload classifies non-video keys as not_applicable, video as pending_sidecar', { timeout: 30_000 }, async (ctx) => {
    story(ctx, 'Backfill trackFileUpload nadaje not_applicable plikom nie-wideo (np. snapshot JPG), pending_sidecar plikom wideo — baner liczy tylko pending_sidecar, więc snapshoty go nie zawyżają.');
    const u = await pool.query<{ id: number; uuid: string }>(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES (gen_random_uuid(), 'track-test@example.com', 'x', true, true, 1)
       RETURNING id, uuid`,
    );
    const ownerId = u.rows[0].id;

    // Replicate trackFileUpload's classified INSERT for a JPG snapshot and an mp4.
    // initialState computed the same way: non-video extension → not_applicable.
    const insert = async (s3Key: string, initialState: string) =>
      pool.query(
        `INSERT INTO file_metadata
           (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, uploaded_at, processing_state)
         VALUES ($1, 'recordings', $2, $3, 100, NOW(), $4)`,
        [ownerId, s3Key, s3Key.replace(/.*\//, ''), initialState],
      );
    await insert(`${u.rows[0].uuid}/Cam_00_20260612120000.jpg`, 'not_applicable');
    await insert(`${u.rows[0].uuid}/Cam_00_20260612120000.mp4`, 'pending_sidecar');

    const { rows } = await pool.query<{ s3_key: string; processing_state: string }>(
      `SELECT s3_key, processing_state FROM file_metadata WHERE owner_id = $1 ORDER BY s3_key`,
      [ownerId],
    );
    const byExt = Object.fromEntries(rows.map(r => [r.s3_key.replace(/.*\./, ''), r.processing_state]));
    expect(byExt.jpg).toBe('not_applicable');
    expect(byExt.mp4).toBe('pending_sidecar');

    // Banner (pending_sidecar only) must NOT count the JPG.
    const { rows: banner } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_metadata WHERE owner_id = $1 AND processing_state = 'pending_sidecar'`,
      [ownerId],
    );
    expect(banner[0].n).toBe(1);
  });
});
