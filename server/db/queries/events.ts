// server/db/queries/events.ts
import { eq, and, sql, isNull, desc, asc, lt } from 'drizzle-orm';
import { db, LOCK_NS_EVENTS, withTx, withUserLock, type Tx } from '../index.js';
import {
  events, fileMetadata, users,
} from '../schema/index.js';
import type { CameraEvent } from '../../types.js';

// Patterns reference: server/db/queries/users.ts (top of file)

// ==== Constants ====

/**
 * Sentinel written to `events.thumbnail` when the thumbnail worker determines
 * the source video is permanently unprocessable. Acts as a tombstone so the
 * scanner + reconciler stop re-enqueueing the job.
 */
export const THUMBNAIL_UNPLAYABLE = '__unplayable__';

/**
 * Canonical "displayable event" SQL predicate — the rows a user actually sees
 * in the grid: not tombstoned, has playable media (an attached view file), and
 * playback-ready. SHARED verbatim by the three user-facing clip-count paths —
 * `getEvents` (grid + total), `getCameraDetails` (the Cameras grid's per-camera
 * "N clips"), and `getDiskUsageByCamera` (the Storage screen's breakdown) — so
 * the counts can't drift apart again (the iOS-vs-web "7975 vs 7961" report came
 * from exactly this drift).
 *
 * `alias` is the events-table reference in the surrounding query (`e` in
 * getEvents, `events` elsewhere). `THUMBNAIL_UNPLAYABLE` is a fixed sentinel, so
 * it's inlined as a SQL literal — no user input, no injection surface.
 */
export function displayableEventPredicateSql(alias: string): string {
  return [
    `${alias}.thumbnail IS DISTINCT FROM '${THUMBNAIL_UNPLAYABLE}'`,
    `EXISTS (SELECT 1 FROM event_view_files elf WHERE elf.event_id = ${alias}.id)`,
    `${alias}.playback_ready = TRUE`,
    `${alias}.playback_unplayable = FALSE`,
  ].join('\n        AND ');
}

/**
 * Internal advisory lock namespace for the recompute playback functions.
 * High 32 bits = 'prop' namespace (0x70726f70), distinct from LOCK_NS_EVENTS.
 * Two-argument form of pg_advisory_xact_lock(class, id) where class=RECOMPUTE_KEY1
 * and id=ownerId.
 */
const RECOMPUTE_OWNER_LOCK_KEY1 = 0x70726f70; // 'prop' — namespace

// Advisory lock namespace for per-event delete-notify cleanup ('delp'). Keyed
// (DELETE_BY_PATH_LOCK_KEY1, hashtext(eventId)) so the two views of a dual-view
// event, deleted by separate concurrent delete-notify messages, serialize on
// the event and can't both skip the "any views left?" check (which would leave
// the row un-deleted).
const DELETE_BY_PATH_LOCK_KEY1 = 0x64656c70; // 'delp' — namespace

// ==== Types ====

export type EventCursor = { timestamp: string; id: string };

export interface CameraDetails {
  camera: string;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
}

export interface CalendarDay {
  /** Local date string YYYY-MM-DD as exposed to the API. */
  date: string;
  /** Total event count on that day, across every camera. */
  count: number;
  /** How many distinct cameras recorded that day. */
  cameraCount: number;
}

export interface FileMetaRow {
  id: number;
  ownerId: number;
  s3Bucket: string;
  s3Key: string;
  originalFilename: string;
  fileSizeBytes: number;
  uploadedAt: string;
}

export interface PlaybackPatchState {
  readyAt: Date | null;
  unplayable: boolean;
  attempts: number;
}

export interface ProcessingFile {
  filename: string;
  uploadedAt: string; // ISO timestamp
}

export interface ProcessingStatus {
  inProgressCount: number;
  inProgressFiles: ProcessingFile[];
}

// Mirrors VIDEO_EXTS in services/scannerExts.ts.
// No longer imported by the ingest service (completeUpload uses scannerExts directly).
// Kept exported for any external consumers — remove in a future cleanup if none remain.
export const PROCESSING_VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'ts', '3gp'] as const;
const PROCESSING_LIST_LIMIT = 100;

// ==== Helpers ====

/**
 * Build a `ANY(ARRAY[$1, $2, ...]::text[])` SQL fragment for use with
 * Drizzle's sql tag. Drizzle expands JS arrays element-by-element rather
 * than passing them as a PG array literal, so we must build the ARRAY[]
 * constructor explicitly via sql.join.
 */
function sqlAnyTextArray(ids: string[]) {
  const items = ids.map(id => sql`${id}`);
  return sql`ANY(ARRAY[${sql.join(items, sql`, `)}]::text[])`;
}

function mapFileMetaRow(r: {
  id: number; ownerId: number; s3Bucket: string; s3Key: string;
  originalFilename: string; fileSizeBytes: number | string;
  uploadedAt: Date | string;
}): FileMetaRow {
  return {
    id: r.id,
    ownerId: r.ownerId,
    s3Bucket: r.s3Bucket,
    s3Key: r.s3Key,
    originalFilename: r.originalFilename,
    fileSizeBytes: Number(r.fileSizeBytes),
    uploadedAt: r.uploadedAt instanceof Date ? r.uploadedAt.toISOString() : String(r.uploadedAt),
  };
}

// ==== Events: simple CRUD ====

export async function getCameraNames(ownerId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ camera: events.camera })
    .from(events)
    .where(
      and(
        eq(events.ownerId, ownerId),
        eq(events.playbackReady, true),
        eq(events.playbackUnplayable, false),
      ),
    )
    .orderBy(asc(events.camera));
  return rows.map(r => r.camera);
}

export async function getCameraDetails(ownerId: number): Promise<CameraDetails[]> {
  // Raw SQL (not the Drizzle builder) so the per-camera "N clips" count applies
  // the EXACT same displayable predicate as the grid (getEvents) and the
  // Storage breakdown (getDiskUsageByCamera) — see displayableEventPredicateSql.
  // Previously this gated only on playback_ready/playback_unplayable, so it
  // still counted tombstoned + media-less rows the grid hides and the Cameras
  // grid's count disagreed with both. `timestamp` is TEXT (capture time), so
  // MIN/MAX return the stored ISO strings unchanged.
  const { pool } = await import('../index.js');
  const result = await pool.query(
    `SELECT camera,
            MIN(timestamp) AS first_event_at,
            MAX(timestamp) AS last_event_at,
            COUNT(*)::int  AS event_count
       FROM events
      WHERE owner_id = $1
        AND ${displayableEventPredicateSql('events')}
      GROUP BY camera
      ORDER BY camera ASC`,
    [ownerId],
  );

  return result.rows.map((r: {
    camera: string;
    first_event_at: string;
    last_event_at: string;
    event_count: number;
  }) => ({
    camera: String(r.camera),
    firstEventAt: String(r.first_event_at),
    lastEventAt: String(r.last_event_at),
    eventCount: Number(r.event_count),
  }));
}

export async function getUserTimezone(userId: number): Promise<string> {
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  return (row?.timezone as string | null | undefined) ?? 'UTC';
}

export async function setUserTimezone(userId: number, timezone: string): Promise<void> {
  await db.update(users).set({ timezone }).where(eq(users.id, userId));
}

export async function getEventCalendar(
  ownerId: number,
  fromDate: string,
  toDate: string,
): Promise<CalendarDay[]> {
  // events.date is TEXT in YYYY/MM/DD form. Convert hyphenated API bounds to slashed DB form.
  const dbFrom = fromDate.replace(/-/g, '/');
  const dbTo = toDate.replace(/-/g, '/');

  const rows = await db
    .select({
      date: events.date,
      count: sql<number>`COUNT(*)::int`,
      cameraCount: sql<number>`COUNT(DISTINCT ${events.camera})::int`,
    })
    .from(events)
    .where(
      and(
        eq(events.ownerId, ownerId),
        sql`${events.date} BETWEEN ${dbFrom} AND ${dbTo}`,
        eq(events.playbackReady, true),
        eq(events.playbackUnplayable, false),
      ),
    )
    .groupBy(events.date)
    .orderBy(asc(events.date));

  return rows.map(r => {
    const raw = typeof r.date === 'string' ? r.date : String(r.date);
    return {
      date: raw.replace(/\//g, '-'),
      count: Number(r.count),
      cameraCount: Number(r.cameraCount),
    };
  });
}

export async function deleteEvent(eventId: string, ownerId: number): Promise<void> {
  await db.delete(events).where(and(eq(events.id, eventId), eq(events.ownerId, ownerId)));
}

export async function getEventCountForUser(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ cnt: sql<string>`COUNT(*)::bigint` })
    .from(events)
    .where(eq(events.ownerId, ownerId));
  return Number(row?.cnt ?? 0);
}

/**
 * Remove a view-file row whose video_rel_path matches `removedRelPath`, then
 * null out the thumbnail if it also matched. Used by the delete-notify path
 * when a single file is removed from an event that still has other view files.
 * (Compare with removeDeletedFileFromEvents which handles the full
 * "maybe delete the event row" flow.)
 */
export async function updateEventFiles(
  eventId: string,
  ownerId: number,
  removedRelPath: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM event_view_files
     WHERE event_id = ${eventId} AND video_rel_path = ${removedRelPath}
  `);
  await db.execute(sql`
    UPDATE events
       SET thumbnail = NULL
     WHERE id = ${eventId} AND owner_id = ${ownerId} AND thumbnail = ${removedRelPath}
  `);
}

export async function getEventByIdForOwner(id: string, ownerId: number): Promise<CameraEvent | undefined> {
  const result = await db.execute<{
    id: string; camera: string; timestamp: string; date: string;
    thumbnail: string | null; duration: number | null; owner_id: number;
    timezone: string; playback_ready: boolean;
    views: CameraEvent['views'] | null;
  }>(sql`
    SELECT e.id, e.camera, e.timestamp, e.date, e.thumbnail, e.duration, e.owner_id,
           e.playback_ready,
           COALESCE(u.timezone, 'UTC') AS timezone,
           COALESCE(
             (SELECT json_agg(
                json_build_object(
                  'id', elf.view_id,
                  'videoRelPath', elf.video_rel_path,
                  'durationMs', elf.duration_ms,
                  'sizeBytes', elf.size_bytes,
                  'frameRate', CASE WHEN elf.frame_rate > 0 THEN elf.frame_rate END
                ) ORDER BY elf.view_id
              )
              FROM event_view_files elf WHERE elf.event_id = e.id),
             '[]'::json
           ) AS views
      FROM events e
      LEFT JOIN users u ON u.id = e.owner_id
     WHERE e.id = ${id} AND e.owner_id = ${ownerId}
  `);
  const r = result.rows[0];
  if (!r) return undefined;
  return {
    id: r.id, camera: r.camera, timestamp: r.timestamp, date: r.date,
    views: (r.views ?? []) as CameraEvent['views'],
    thumbnail: r.thumbnail,
    duration: r.duration ?? undefined, ownerId: r.owner_id,
    timezone: r.timezone,
    playbackReady: r.playback_ready === true,
  };
}

export async function getEventByIdAnyOwner(id: string): Promise<CameraEvent | undefined> {
  const result = await db.execute<{
    id: string; camera: string; timestamp: string; date: string;
    thumbnail: string | null; duration: number | null; owner_id: number;
    views: CameraEvent['views'] | null;
  }>(sql`
    SELECT e.id, e.camera, e.timestamp, e.date, e.thumbnail, e.duration, e.owner_id,
           COALESCE(
             (SELECT json_agg(
                json_build_object(
                  'id', elf.view_id,
                  'videoRelPath', elf.video_rel_path,
                  'durationMs', elf.duration_ms,
                  'sizeBytes', elf.size_bytes,
                  'frameRate', CASE WHEN elf.frame_rate > 0 THEN elf.frame_rate END
                ) ORDER BY elf.view_id
              )
              FROM event_view_files elf WHERE elf.event_id = e.id),
             '[]'::json
           ) AS views
      FROM events e WHERE e.id = ${id}
  `);
  const r = result.rows[0];
  if (!r) return undefined;
  return {
    id: r.id, camera: r.camera, timestamp: r.timestamp, date: r.date,
    views: (r.views ?? []) as CameraEvent['views'],
    thumbnail: r.thumbnail,
    duration: r.duration ?? undefined, ownerId: r.owner_id,
  };
}

// ==== Events: thumbnail/duration helpers ====

export async function updateEventThumbnail(eventId: string, ownerId: number, thumbnail: string): Promise<void> {
  await db
    .update(events)
    .set({ thumbnail })
    .where(and(eq(events.id, eventId), eq(events.ownerId, ownerId)));
}

export async function incrementThumbnailAttempts(eventId: string, ownerId: number): Promise<number> {
  const [row] = await db
    .update(events)
    .set({ thumbnailAttempts: sql`${events.thumbnailAttempts} + 1` })
    .where(and(eq(events.id, eventId), eq(events.ownerId, ownerId)))
    .returning({ thumbnailAttempts: events.thumbnailAttempts });
  if (!row) return 0;
  return Number(row.thumbnailAttempts);
}

export async function updateEventDuration(eventId: string, ownerId: number, duration: number): Promise<void> {
  await db
    .update(events)
    .set({ duration })
    .where(and(eq(events.id, eventId), eq(events.ownerId, ownerId)));
}

/**
 * Persist the measured frame rate for a single view file.
 * Ownership is enforced via a subquery on events.owner_id.
 * Only updates when the event belongs to ownerId — a mismatched owner
 * silently no-ops (UPDATE on 0 rows), consistent with the rest of this module.
 */
export async function updateEventViewFrameRate(
  eventId: string,
  ownerId: number,
  videoRelPath: string,
  frameRate: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE event_view_files SET frame_rate = ${frameRate}
     WHERE video_rel_path = ${videoRelPath}
       AND event_id = (SELECT id FROM events WHERE id = ${eventId} AND owner_id = ${ownerId})
  `);
}

/**
 * Remove a single view-file row from event_view_files by viewId.
 * Ownership is enforced via a subquery on events.owner_id.
 * v10 replaces the old "null the wide_video/zoom_video column" semantics.
 */
export async function collapseEventView(
  eventId: string,
  ownerId: number,
  viewId: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM event_view_files
     WHERE view_id = ${viewId}
       AND event_id = (SELECT id FROM events WHERE id = ${eventId} AND owner_id = ${ownerId})
  `);
}

/**
 * Return up to `limit` event_view_files rows whose frame_rate has never been
 * written (NULL) but whose file_metadata is already patch-ready (sidecar on
 * S3). Used by the `backfillFrameRates` reconciler to index the original
 * recording and get true sample counts.
 *
 * When `includeWrong` is true the WHERE also matches rows whose `frame_rate`
 * is suspiciously high (> 121 fps) — these hold the legacy ~10× inflated value
 * from the old `frameRateFromTrex` path and need to be re-indexed. The cutoff
 * 121 is safe because real Reolink clips stay ≤ ~60 fps; the bug multiplies by
 * ~10 giving ~150. This is self-quiescing: once corrected to ~15 the row no
 * longer matches `> 121`.
 *
 * The join uses `u.uuid || '/' || elf.video_rel_path` — the canonical s3_key
 * shape for all file_metadata rows (same predicate as OWNERS_WITH_STALE_PLAYBACK_READY_SQL).
 * Excludes sentinel rows (frame_rate = -1) via IS NULL — those were already
 * tried and deemed undeterminable; they fall out of the WHERE naturally.
 */
export async function getViewsMissingFrameRate(limit: number, includeWrong = false): Promise<
  Array<{ eventId: string; ownerId: number; videoRelPath: string; s3Key: string; encryptionSalt: string | null }>
> {
  const result = await db.execute<{
    eventId: string;
    ownerId: number;
    videoRelPath: string;
    s3Key: string;
    encryptionSalt: string | null;
  }>(sql`
    SELECT elf.event_id AS "eventId", e.owner_id AS "ownerId",
           elf.video_rel_path AS "videoRelPath", fm.s3_key AS "s3Key",
           u.encryption_salt AS "encryptionSalt"
      FROM event_view_files elf
      JOIN events e ON e.id = elf.event_id
      JOIN users u ON u.id = e.owner_id
      JOIN file_metadata fm
        ON fm.owner_id = e.owner_id
       AND fm.s3_key = u.uuid || '/' || elf.video_rel_path
     WHERE (elf.frame_rate IS NULL${includeWrong ? sql` OR elf.frame_rate > 121` : sql``})
       AND fm.processing_state = 'ready'
     LIMIT ${limit}
  `);
  return result.rows;
}

export async function getEventsMissingThumbnail(limit: number): Promise<{ id: string; ownerId: number }[]> {
  const rows = await db
    .select({ id: events.id, ownerId: events.ownerId })
    .from(events)
    .where(
      and(
        isNull(events.thumbnail),
        sql`EXISTS (SELECT 1 FROM event_view_files elf WHERE elf.event_id = ${events.id})`,
      ),
    )
    .orderBy(desc(events.date))
    .limit(limit);
  return rows.map(r => ({ id: r.id, ownerId: r.ownerId! }));
}

export async function getEventsMissingSidecar(limit: number): Promise<{ id: string; ownerId: number }[]> {
  // v10: JOIN through event_view_files instead of wide_video/zoom_video columns.
  // GROUP BY so ORDER BY can reference MAX(e.date) aggregate.
  const result = await db.execute<{ id: string; ownerId: number }>(sql`
    SELECT e.id, e.owner_id AS "ownerId"
      FROM events e
      JOIN event_view_files elf ON elf.event_id = e.id
      JOIN users u ON u.id = e.owner_id
      JOIN file_metadata fm
        ON fm.owner_id = e.owner_id
       AND fm.s3_key ~* '\\.(mp4|m4v|mov|mkv|webm|avi|ts|3gp)$'
       AND SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) = elf.video_rel_path
     WHERE fm.processing_state = 'pending_sidecar'
     GROUP BY e.id, e.owner_id
     ORDER BY MAX(e.date) DESC
     LIMIT ${limit}
  `);
  return result.rows;
}

export async function getMissingDurationEvents(
  ownerId: number,
): Promise<{ id: string; views: { id: string; videoRelPath: string }[] }[]> {
  const result = await db.execute<{
    id: string;
    views: Array<{ id: string; videoRelPath: string }> | null;
  }>(sql`
    SELECT e.id,
           COALESCE(
             (SELECT json_agg(
                json_build_object('id', elf.view_id, 'videoRelPath', elf.video_rel_path)
                ORDER BY elf.view_id
              )
              FROM event_view_files elf WHERE elf.event_id = e.id),
             '[]'::json
           ) AS views
      FROM events e
     WHERE e.owner_id = ${ownerId}
       AND e.duration IS NULL
       AND EXISTS (SELECT 1 FROM event_view_files elf2 WHERE elf2.event_id = e.id)
  `);
  return result.rows.map(r => ({
    id: r.id,
    views: (r.views ?? []) as Array<{ id: string; videoRelPath: string }>,
  }));
}

export async function getEventRefsByOwner(
  ownerId: number,
): Promise<{ id: string; views: Array<{ id: string; videoRelPath: string }>; thumbnail: string | null }[]> {
  const result = await db.execute<{
    id: string; thumbnail: string | null;
    views: Array<{ id: string; videoRelPath: string }> | null;
  }>(sql`
    SELECT e.id, e.thumbnail,
           COALESCE(
             (SELECT json_agg(
                json_build_object('id', elf.view_id, 'videoRelPath', elf.video_rel_path)
                ORDER BY elf.view_id
              )
              FROM event_view_files elf WHERE elf.event_id = e.id),
             '[]'::json
           ) AS views
      FROM events e WHERE e.owner_id = ${ownerId}
  `);
  return result.rows.map(r => ({
    id: r.id,
    views: (r.views ?? []) as Array<{ id: string; videoRelPath: string }>,
    thumbnail: r.thumbnail,
  }));
}

export async function countZombieEvents(): Promise<number> {
  const [row] = await db
    .select({ cnt: sql<string>`COUNT(*)` })
    .from(events)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM event_view_files elf WHERE elf.event_id = ${events.id})`,
    );
  return parseInt(row?.cnt ?? '0', 10);
}

export async function cleanupOldZombieEvents(olderThanMinutes: number): Promise<number> {
  const thresholdIso = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const result = await db.execute(sql`
    DELETE FROM events e
     WHERE NOT EXISTS (SELECT 1 FROM event_view_files elf WHERE elf.event_id = e.id)
       AND e.timestamp < ${thresholdIso}
  `);
  return result.rowCount ?? 0;
}

// ==== Events: getEvents (sql tag — conditional WHERE builder) ====

export async function getEvents(opts: {
  cameras?: string[];
  dateFrom?: string;
  dateTo?: string;
  /** Daily time-of-day mask, HH:MM. When timeFrom <= timeTo: BETWEEN. When
   * timeFrom > timeTo: wrap-around through midnight (>= timeFrom OR <= timeTo).
   * Caller passes both or neither — half-set is ignored upstream. */
  timeFrom?: string;
  timeTo?: string;
  /** Continuous datetime range (mode='range'), ISO strings. When set, takes
   * precedence over dateFrom/dateTo/timeFrom/timeTo. `rangeTo` is exclusive. */
  rangeFrom?: string;
  rangeTo?: string;
  cursor?: EventCursor;
  limit: number;
  userId?: number;
  ownerId?: number;
}): Promise<{ events: CameraEvent[]; total: number; nextCursor: EventCursor | null }> {
  // Keep on raw sql tag — multi-condition conditional WHERE builder is clearest this way.
  // The addParam helper accumulates positional params ($1, $2, …).
  const whereParams: unknown[] = [];
  const addParam = (val: unknown): string => {
    whereParams.push(val);
    return `$${whereParams.length}`;
  };

  const conditions: string[] = [];

  // Canonical displayable-event predicate (tombstone + has-media + playback
  // gate), shared verbatim with getCameraDetails + getDiskUsageByCamera so all
  // three user-facing clip counts agree. See displayableEventPredicateSql.
  conditions.push(displayableEventPredicateSql('e'));

  if (opts.ownerId !== undefined) {
    conditions.push(`e.owner_id = ${addParam(opts.ownerId)}`);
  }
  if (opts.cameras && opts.cameras.length > 0) {
    const placeholders = opts.cameras.map(c => addParam(c)).join(',');
    conditions.push(`e.camera IN (${placeholders})`);
  }

  if (opts.rangeFrom || opts.rangeTo) {
    if (opts.rangeFrom) {
      conditions.push(`e.timestamp >= ${addParam(opts.rangeFrom)}`);
    }
    if (opts.rangeTo) {
      conditions.push(`e.timestamp < ${addParam(opts.rangeTo)}`);
    }
  } else {
    if (opts.dateFrom) {
      conditions.push(`e.timestamp >= ${addParam(opts.dateFrom)}`);
    }
    if (opts.dateTo) {
      conditions.push(`e.timestamp <= ${addParam(opts.dateTo + 'T23:59:59.999Z')}`);
    }
    if (opts.timeFrom && opts.timeTo) {
      if (opts.timeFrom <= opts.timeTo) {
        conditions.push(
          `substring(e.timestamp from 12 for 5) BETWEEN ${addParam(opts.timeFrom)} AND ${addParam(opts.timeTo)}`,
        );
      } else {
        const a = addParam(opts.timeFrom);
        const b = addParam(opts.timeTo);
        conditions.push(
          `(substring(e.timestamp from 12 for 5) >= ${a} OR substring(e.timestamp from 12 for 5) <= ${b})`,
        );
      }
    }
  }

  if (opts.cursor) {
    conditions.push(
      `(e.timestamp, e.id) < (${addParam(opts.cursor.timestamp)}, ${addParam(opts.cursor.id)})`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalParamCount = opts.cursor ? whereParams.length - 2 : whereParams.length;
  const totalConditions = opts.cursor ? conditions.slice(0, -1) : conditions;
  const totalWhere = totalConditions.length > 0 ? `WHERE ${totalConditions.join(' AND ')}` : '';

  const { pool } = await import('../index.js');
  const countResult = await pool.query(
    `SELECT COUNT(*) as cnt FROM events e ${totalWhere}`,
    whereParams.slice(0, totalParamCount),
  );
  const total = parseInt(countResult.rows[0].cnt, 10);

  const fetchLimit = opts.limit + 1;
  const selectParams = [...whereParams, THUMBNAIL_UNPLAYABLE, fetchLimit];
  const tombstonePlaceholder = `$${selectParams.length - 1}`;
  const limitPlaceholder = `$${selectParams.length}`;

  const rowsResult = await pool.query(
    `SELECT e.id, e.camera, e.timestamp, e.date, e.thumbnail, e.duration,
            (e.thumbnail = ${tombstonePlaceholder}) AS thumbnail_failed,
            COALESCE(u.timezone, 'UTC') AS timezone,
            COALESCE(
              (SELECT json_agg(
                 json_build_object(
                   'id', elf.view_id,
                   'videoRelPath', elf.video_rel_path,
                   'durationMs', elf.duration_ms,
                   'sizeBytes', elf.size_bytes,
                   'frameRate', CASE WHEN elf.frame_rate > 0 THEN elf.frame_rate END
                 ) ORDER BY elf.view_id
               )
               FROM event_view_files elf WHERE elf.event_id = e.id),
              '[]'::json
            ) AS views
     FROM events e
     LEFT JOIN users u ON u.id = e.owner_id
     ${where} ORDER BY e.timestamp DESC, e.id DESC LIMIT ${limitPlaceholder}`,
    selectParams,
  );

  const hasMore = rowsResult.rows.length > opts.limit;
  if (hasMore) rowsResult.rows.length = opts.limit;

  const eventsResult: CameraEvent[] = rowsResult.rows.map((r: {
    id: string; camera: string; timestamp: string; date: string;
    thumbnail: string | null; duration: number | null; timezone: string;
    thumbnail_failed: boolean;
    views: CameraEvent['views'] | null;
  }) => ({
    id: r.id, camera: r.camera, timestamp: r.timestamp, date: r.date,
    views: (r.views ?? []) as CameraEvent['views'],
    thumbnail: r.thumbnail,
    duration: r.duration ?? undefined, timezone: r.timezone,
    thumbnailFailed: r.thumbnail_failed === true,
  }));

  const nextCursor: EventCursor | null =
    hasMore && eventsResult.length > 0
      ? { timestamp: eventsResult[eventsResult.length - 1].timestamp, id: eventsResult[eventsResult.length - 1].id }
      : null;

  return { events: eventsResult, total, nextCursor };
}

// ==== Events: replace/upsert (advisory lock) ====

/**
 * Bulk-insert view-file rows for a chunk of events. Used by
 * `replaceUserEvents` (full-scan) and `upsertEventsDelta` (delta path).
 * The caller is responsible for the surrounding transaction and for clearing
 * existing rows when "replace" semantics are wanted.
 * Postgres parameter limit ($65535) is respected via inner chunking —
 * 5 cols × 12000 rows = 60000 placeholders, comfortably under.
 */
async function insertEventViewFiles(
  tx: Tx,
  evts: CameraEvent[],
  opts: { onConflict?: 'doNothing' | 'overwrite' } = {},
): Promise<void> {
  const onConflict = opts.onConflict ?? 'overwrite';
  // sql.raw for the static ON CONFLICT suffix — no user data, safe.
  const conflictSuffix = onConflict === 'doNothing'
    ? sql.raw('ON CONFLICT (event_id, view_id) DO NOTHING')
    : sql.raw(`ON CONFLICT (event_id, view_id) DO UPDATE SET
         video_rel_path = EXCLUDED.video_rel_path,
         duration_ms = COALESCE(EXCLUDED.duration_ms, event_view_files.duration_ms),
         size_bytes = COALESCE(EXCLUDED.size_bytes, event_view_files.size_bytes)`);

  const rows: Array<{ eventId: string; viewId: string; relPath: string; durationMs: number | null; sizeBytes: number | null }> = [];
  for (const e of evts) {
    for (const l of e.views) {
      rows.push({
        eventId: e.id,
        viewId: l.id,
        relPath: l.videoRelPath,
        durationMs: l.durationMs ?? null,
        sizeBytes: l.sizeBytes ?? null,
      });
    }
  }
  if (rows.length === 0) return;

  const VIEW_CHUNK = 1500;
  for (let i = 0; i < rows.length; i += VIEW_CHUNK) {
    const chunk = rows.slice(i, i + VIEW_CHUNK);
    // Build multi-row VALUES via sql.join so each param is properly bound.
    const tuples = chunk.map(r => sql`(${r.eventId}, ${r.viewId}, ${r.relPath}, ${r.durationMs}, ${r.sizeBytes})`);
    await tx.execute(sql`
      INSERT INTO event_view_files (event_id, view_id, video_rel_path, duration_ms, size_bytes)
      VALUES ${sql.join(tuples, sql`, `)}
      ${conflictSuffix}
    `);
  }
}

export async function replaceUserEvents(ownerId: number, evts: CameraEvent[]): Promise<void> {
  // withUserLock wraps BEGIN + pg_advisory_xact_lock(LOCK_NS_EVENTS, ownerId) + COMMIT automatically.
  return withUserLock(LOCK_NS_EVENTS, ownerId, async (tx) => {
    await tx.execute(sql`SET LOCAL application_name = 'event-manager:replaceUserEvents'`);

    const newIds = new Set(evts.map(e => e.id));
    const existingResult = await tx.execute<{ id: string }>(sql`
      SELECT id FROM events WHERE owner_id = ${ownerId}
    `);
    const obsoleteIds = existingResult.rows.map(r => r.id).filter(id => !newIds.has(id));
    if (obsoleteIds.length > 0) {
      await tx.execute(sql`DELETE FROM events WHERE id = ${sqlAnyTextArray(obsoleteIds)}`);
      await tx.execute(sql`
        DELETE FROM notifications WHERE details ->> 'eventId' = ${sqlAnyTextArray(obsoleteIds)}
      `);
    }

    const CHUNK = 1000;
    const eventsConflictSuffix = sql.raw(`ON CONFLICT (id) DO UPDATE SET
           camera = EXCLUDED.camera, timestamp = EXCLUDED.timestamp, date = EXCLUDED.date,
           thumbnail = COALESCE(events.thumbnail, EXCLUDED.thumbnail),
           owner_id = EXCLUDED.owner_id`);
    for (let i = 0; i < evts.length; i += CHUNK) {
      const chunk = evts.slice(i, i + CHUNK);
      // Build multi-row VALUES via sql.join so each param is properly bound.
      const tuples = chunk.map(e => sql`(${e.id}, ${e.camera}, ${e.timestamp}, ${e.date}, ${e.thumbnail}, ${ownerId})`);
      await tx.execute(sql`
        INSERT INTO events (id, camera, timestamp, date, thumbnail, owner_id)
        VALUES ${sql.join(tuples, sql`, `)}
        ${eventsConflictSuffix}
      `);

      // Replace view-file rows for the events in this chunk — delete stale rows
      // then re-insert the fresh set (full-scan: source of truth).
      const chunkIds = chunk.map(e => e.id);
      await tx.execute(sql`DELETE FROM event_view_files WHERE event_id = ${sqlAnyTextArray(chunkIds)}`);
      await insertEventViewFiles(tx, chunk);
    }
  }).catch((err) => {
    const code = (err as { code?: string })?.code;
    if (code === '40P01') {
      console.error(
        `replaceUserEvents: 40P01 deadlock for owner=${ownerId} ` +
        `events=${evts.length} — see scanner.runScanWithDeadlockRetry`,
      );
    }
    throw err;
  });
}

export async function upsertEventsDelta(
  ownerId: number,
  evts: CameraEvent[],
): Promise<void> {
  if (evts.length === 0) return;
  // withUserLock wraps BEGIN + pg_advisory_xact_lock(LOCK_NS_EVENTS, ownerId) + COMMIT automatically.
  return withUserLock(LOCK_NS_EVENTS, ownerId, async (tx) => {
    await tx.execute(sql`SET LOCAL application_name = 'event-manager:upsertEventsDelta'`);

    const CHUNK = 1000;
    const eventsConflictSuffix = sql.raw(`ON CONFLICT (id) DO UPDATE SET
           camera = EXCLUDED.camera, timestamp = EXCLUDED.timestamp, date = EXCLUDED.date,
           thumbnail = COALESCE(events.thumbnail, EXCLUDED.thumbnail),
           owner_id = EXCLUDED.owner_id`);
    for (let i = 0; i < evts.length; i += CHUNK) {
      const chunk = evts.slice(i, i + CHUNK);
      // Build multi-row VALUES via sql.join so each param is properly bound.
      const tuples = chunk.map(e => sql`(${e.id}, ${e.camera}, ${e.timestamp}, ${e.date}, ${e.thumbnail}, ${ownerId})`);
      await tx.execute(sql`
        INSERT INTO events (id, camera, timestamp, date, thumbnail, owner_id)
        VALUES ${sql.join(tuples, sql`, `)}
        ${eventsConflictSuffix}
      `);

      // Delta path: preserve existing view files on conflict (first-wins).
      await insertEventViewFiles(tx, chunk, { onConflict: 'doNothing' });
    }
  }).catch((err) => {
    const code = (err as { code?: string })?.code;
    if (code === '40P01') {
      console.error(
        `upsertEventsDelta: 40P01 deadlock for owner=${ownerId} ` +
        `events=${evts.length} — see scanner.runScanWithDeadlockRetry`,
      );
    }
    throw err;
  });
}

// ==== Events: playback patch state ====

export async function getPlaybackPatchState(
  fileMetadataId: number,
): Promise<PlaybackPatchState | null> {
  const [row] = await db
    .select({
      processingState: fileMetadata.processingState,
      attempts: fileMetadata.processingAttempts,
    })
    .from(fileMetadata)
    .where(eq(fileMetadata.id, fileMetadataId));

  if (!row) return null;
  return {
    readyAt: row.processingState === 'ready' ? new Date() : null,
    unplayable: row.processingState === 'unplayable',
    attempts: Number(row.attempts ?? 0),
  };
}

export async function incrementPlaybackPatchAttempts(
  fileMetadataId: number,
): Promise<number> {
  const [row] = await db
    .update(fileMetadata)
    .set({
      processingAttempts: sql`${fileMetadata.processingAttempts} + 1`,
      nextRetryAt: sql`NOW() + LEAST(make_interval(secs => POWER(2, ${fileMetadata.processingAttempts}) * 60), interval '1 hour')`,
    })
    .where(eq(fileMetadata.id, fileMetadataId))
    .returning({ processingAttempts: fileMetadata.processingAttempts });
  if (!row) return Number.MAX_SAFE_INTEGER;
  return Number(row.processingAttempts);
}

/**
 * Record the sidecar builder's structural truncation verdict.
 *
 * Written unconditionally (not only when true) so a re-upload that finally
 * lands the file in full clears the flag — the column always describes the
 * bytes currently in the bucket. Cheap no-op UPDATE when the value is
 * unchanged, which is the overwhelmingly common case.
 */
export async function setFileTruncated(
  fileMetadataId: number,
  truncated: boolean,
): Promise<void> {
  await db
    .update(fileMetadata)
    .set({ truncated })
    .where(eq(fileMetadata.id, fileMetadataId));
}

export async function markPlaybackPatchReady(
  fileMetadataId: number,
): Promise<void> {
  const [row] = await db
    .update(fileMetadata)
    .set({ processingState: 'ready', nextRetryAt: null })
    .where(eq(fileMetadata.id, fileMetadataId))
    .returning({ ownerId: fileMetadata.ownerId });
  if (!row) return;
  await recomputeEventsPlaybackReadyForFile(fileMetadataId);
}

export async function markPlaybackPatchUnplayable(
  fileMetadataId: number,
): Promise<void> {
  const [row] = await db
    .update(fileMetadata)
    .set({ processingState: 'unplayable', nextRetryAt: null })
    .where(eq(fileMetadata.id, fileMetadataId))
    .returning({ ownerId: fileMetadata.ownerId });
  if (!row) return;
  await recomputeEventsPlaybackReadyForFile(fileMetadataId);
}

// ==== Events: recompute playback (CTE + advisory lock) ====
// These use BOOL_AND/BOOL_OR aggregates + two-argument advisory lock form
// (pg_advisory_xact_lock(class, id)) — keep on raw sql tag for clarity.

// The UPDATE SQL is shared between the per-owner function and its tests (which
// pass a pre-opened client for schema isolation). The raw string form ($1/$2) is
// used by the test override path (pg.PoolClient). The sql-tag form is used by
// the production path (withTx).
// v10: uses event_view_files JOIN instead of wide_video/zoom_video columns.
const RECOMPUTE_PLAYBACK_READY_SQL = `WITH user_uuid AS (
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
        AND e.owner_id = $1`;

// sql-tag form for the production path — params bound inline.
const recomputePlaybackReadySql = (ownerId: number, unplayable: string) => sql`
  WITH user_uuid AS (
       SELECT uuid FROM users WHERE id = ${ownerId}
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
       WHERE e.owner_id = ${ownerId}
       GROUP BY e.id
     )
     UPDATE events e
        SET playback_ready = COALESCE(a.all_files_ready, FALSE),
            playback_unplayable = (
              e.thumbnail IS NOT DISTINCT FROM ${unplayable}
              OR COALESCE(a.any_unplayable, FALSE)
            )
       FROM attached a
      WHERE a.event_id = e.id
        AND e.owner_id = ${ownerId}
`;

export async function recomputeEventsPlaybackReadyForOwner(
  ownerId: number,
  client?: import('pg').PoolClient,
): Promise<void> {
  // Test override: caller already owns a transaction-scoped pg.PoolClient.
  // The raw positional-param form ($1/$2) is kept for the test path because
  // tests set a custom search_path on the session before calling this function.
  if (client) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      RECOMPUTE_OWNER_LOCK_KEY1,
      ownerId,
    ]);
    await client.query(RECOMPUTE_PLAYBACK_READY_SQL, [ownerId, THUMBNAIL_UNPLAYABLE]);
    return;
  }
  // Production path: withTx acquires a transaction; advisory lock ensures
  // only one recompute per owner runs concurrently. Two-arg form matches the
  // test override above — different lock class from LOCK_NS_EVENTS.
  return withTx(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECOMPUTE_OWNER_LOCK_KEY1}, ${ownerId})`);
    await tx.execute(recomputePlaybackReadySql(ownerId, THUMBNAIL_UNPLAYABLE));
  });
}

// v10: uses event_view_files JOIN instead of wide_video/zoom_video columns.
// Raw string form ($1/$2) used by the test override path (pg.PoolClient).
const RECOMPUTE_PLAYBACK_READY_FOR_FILE_SQL = `WITH file AS (
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
      WHERE a.event_id = e.id`;

// sql-tag form for the production path — params bound inline.
const recomputePlaybackReadyForFileSql = (fileMetadataId: number, unplayable: string) => sql`
  WITH file AS (
       SELECT fm.id, fm.owner_id, u.uuid,
              SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) AS rel_path
       FROM file_metadata fm
       JOIN users u ON u.id = fm.owner_id
       WHERE fm.id = ${fileMetadataId}
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
              e.thumbnail IS NOT DISTINCT FROM ${unplayable}
              OR COALESCE(a.any_unplayable, FALSE)
            )
       FROM attached a
      WHERE a.event_id = e.id
`;

export async function recomputeEventsPlaybackReadyForFile(
  fileMetadataId: number,
  client?: import('pg').PoolClient,
): Promise<void> {
  // Test override: caller already owns a transaction-scoped pg.PoolClient.
  // The raw positional-param form ($1/$2) is kept for the test path because
  // tests set a custom search_path on the session before calling this function.
  if (client) {
    const r = await client.query<{ owner_id: number }>(
      'SELECT owner_id FROM file_metadata WHERE id = $1',
      [fileMetadataId],
    );
    if (r.rowCount === 0) return;
    const ownerId = Number(r.rows[0].owner_id);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      RECOMPUTE_OWNER_LOCK_KEY1,
      ownerId,
    ]);
    await client.query(RECOMPUTE_PLAYBACK_READY_FOR_FILE_SQL, [
      fileMetadataId,
      THUMBNAIL_UNPLAYABLE,
    ]);
    return;
  }
  // Production path: withTx acquires a transaction; advisory lock ensures
  // only one recompute per owner runs concurrently. Two-arg form matches the
  // test override above — different lock class from LOCK_NS_EVENTS.
  return withTx(async (tx) => {
    const r = await tx.execute<{ owner_id: number }>(sql`
      SELECT owner_id FROM file_metadata WHERE id = ${fileMetadataId}
    `);
    if (r.rows.length === 0) return;
    const ownerId = Number(r.rows[0].owner_id);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECOMPUTE_OWNER_LOCK_KEY1}, ${ownerId})`);
    await tx.execute(recomputePlaybackReadyForFileSql(fileMetadataId, THUMBNAIL_UNPLAYABLE));
  });
}

// ==== Events: per-event recompute (event-scoped, O(elf rows for one event)) ====

// Raw string form ($1 = eventId, $2 = THUMBNAIL_UNPLAYABLE) used by the test
// override path (pg.PoolClient).  The sql-tag form is used by the production path.
// Differs from RECOMPUTE_PLAYBACK_READY_SQL only in scope: the attached CTE
// and UPDATE are both pinned to a single event id, and the user uuid is derived
// via a sub-select on the event's owner instead of passing ownerId as a param.
const RECOMPUTE_PLAYBACK_READY_FOR_EVENT_SQL = `WITH user_uuid AS (
       SELECT u.uuid FROM users u
       JOIN events e ON e.owner_id = u.id
       WHERE e.id = $1
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
       WHERE e.id = $1
       GROUP BY e.id
     )
     UPDATE events e
        SET playback_ready = COALESCE(a.all_files_ready, FALSE),
            playback_unplayable = (
              e.thumbnail IS NOT DISTINCT FROM $2
              OR COALESCE(a.any_unplayable, FALSE)
            )
       FROM attached a
      WHERE a.event_id = e.id`;

// sql-tag form for the production path — params bound inline.
const recomputePlaybackReadyForEventSql = (eventId: string, unplayable: string) => sql`
  WITH user_uuid AS (
       SELECT u.uuid FROM users u
       JOIN events e ON e.owner_id = u.id
       WHERE e.id = ${eventId}
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
       WHERE e.id = ${eventId}
       GROUP BY e.id
     )
     UPDATE events e
        SET playback_ready = COALESCE(a.all_files_ready, FALSE),
            playback_unplayable = (
              e.thumbnail IS NOT DISTINCT FROM ${unplayable}
              OR COALESCE(a.any_unplayable, FALSE)
            )
       FROM attached a
      WHERE a.event_id = e.id
`;

/**
 * Recompute `playback_ready` / `playback_unplayable` for a single event.
 * O(elf rows for that one event) — use instead of `recomputeEventsPlaybackReadyForOwner`
 * whenever the affected scope is known to be exactly one event.
 *
 * Advisory lock is taken on the event's owner (same namespace as the owner-wide
 * variant) so concurrent per-event recomputes on the same owner serialise cleanly.
 */
export async function recomputeEventsPlaybackReadyForEvent(
  eventId: string,
  client?: import('pg').PoolClient,
): Promise<void> {
  if (client) {
    // Test override: derive ownerId from the event so we can take the advisory lock.
    const r = await client.query<{ owner_id: number }>(
      'SELECT owner_id FROM events WHERE id = $1',
      [eventId],
    );
    if (r.rowCount === 0) return;
    const ownerId = Number(r.rows[0].owner_id);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      RECOMPUTE_OWNER_LOCK_KEY1,
      ownerId,
    ]);
    await client.query(RECOMPUTE_PLAYBACK_READY_FOR_EVENT_SQL, [eventId, THUMBNAIL_UNPLAYABLE]);
    return;
  }
  return withTx(async (tx) => {
    const r = await tx.execute<{ owner_id: number }>(sql`
      SELECT owner_id FROM events WHERE id = ${eventId}
    `);
    if (r.rows.length === 0) return;
    const ownerId = Number(r.rows[0].owner_id);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECOMPUTE_OWNER_LOCK_KEY1}, ${ownerId})`);
    await tx.execute(recomputePlaybackReadyForEventSql(eventId, THUMBNAIL_UNPLAYABLE));
  });
}

// ==== Events: stale-playback feeder queries ====

// Feeder query for `reconcileStalePlaybackReady` (services/reconcilers.ts).
// "Stale not-ready" = an event that LOOKS finished — thumbnail present (and
// not the tombstone), at least one view file, EVERY linked file_metadata row
// patch-ready and not unplayable — yet still sits at playback_ready=FALSE.
// That state is only reachable when the event row was (re)created AFTER its
// files were already patch-ready (full-rescan displaced-event synthesis,
// slot heals, admin rescans): `markPlaybackPatchReady` never fires again for
// those files, so the event stays invisible in the grid forever.
//
// The NOT EXISTS arm deliberately treats a MISSING file_metadata row, a
// pending one (processing_state = 'pending_sidecar') and an unplayable one as
// "not stale" — those events are legitimately not-ready and the normal
// mark-on-patch pipeline will recompute them when the file lands; sweeping
// them here would recompute their owners every minute for nothing.
//
// file_metadata is matched via `u.uuid || '/' || elf.video_rel_path` — same
// key shape as RECOMPUTE_PLAYBACK_READY_FOR_FILE_SQL above.
//
// Raw string form ($1 = limit) used by the test override path (pg.PoolClient).
//
// EVENT-LEVEL variant: returns individual stale event ids (not owner ids),
// so the reconciler can call recomputeEventsPlaybackReadyForEvent per event —
// never owner-wide. Bounded by LIMIT (default 500) so one sweep can't run
// unbounded; the next minute's pass catches the rest.
const STALE_PLAYBACK_READY_EVENT_IDS_SQL = `SELECT e.id AS event_id
       FROM events e
       JOIN users u ON u.id = e.owner_id
      WHERE e.playback_ready = FALSE
        AND e.playback_unplayable = FALSE
        AND EXISTS (
          SELECT 1 FROM event_view_files elf WHERE elf.event_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_view_files elf
            LEFT JOIN file_metadata fm
              ON fm.owner_id = e.owner_id
             AND fm.s3_key = u.uuid || '/' || elf.video_rel_path
           WHERE elf.event_id = e.id
             AND (fm.id IS NULL
                  OR fm.processing_state <> 'ready')
        )
      LIMIT $1`;

// sql-tag form for the production path.
const stalePlaybackReadyEventIdsSql = (limit: number) => sql`
  SELECT e.id AS event_id
       FROM events e
       JOIN users u ON u.id = e.owner_id
      WHERE e.playback_ready = FALSE
        AND e.playback_unplayable = FALSE
        AND EXISTS (
          SELECT 1 FROM event_view_files elf WHERE elf.event_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_view_files elf
            LEFT JOIN file_metadata fm
              ON fm.owner_id = e.owner_id
             AND fm.s3_key = u.uuid || '/' || elf.video_rel_path
           WHERE elf.event_id = e.id
             AND (fm.id IS NULL
                  OR fm.processing_state <> 'ready')
        )
      LIMIT ${limit}
`;

/**
 * Event ids that are stale not-ready (same predicate as the owner-level variant,
 * but returns event ids directly). Consumed by `reconcileStalePlaybackReady`,
 * which recomputes per event. Bounded by `limit` so one sweep is never unbounded.
 */
export async function getStalePlaybackReadyEventIds(
  limit = 500,
  client?: import('pg').PoolClient,
): Promise<string[]> {
  if (client) {
    const r = await client.query<{ event_id: string }>(
      STALE_PLAYBACK_READY_EVENT_IDS_SQL,
      [limit],
    );
    return r.rows.map(row => String(row.event_id));
  }
  const result = await db.execute<{ event_id: string }>(
    stalePlaybackReadyEventIdsSql(limit),
  );
  return result.rows.map(row => String(row.event_id));
}

// OWNER-LEVEL feeder query kept for tests and backward compat.
// No hot/cron path calls this directly any more (reconciler was migrated to
// the per-event variant above); it remains available for admin/one-off uses.
// Raw string form ($1 = limit) used by the test override path (pg.PoolClient).
const OWNERS_WITH_STALE_PLAYBACK_READY_SQL = `SELECT DISTINCT e.owner_id
       FROM events e
       JOIN users u ON u.id = e.owner_id
      WHERE e.playback_ready = FALSE
        AND e.playback_unplayable = FALSE
        AND EXISTS (
          SELECT 1 FROM event_view_files elf WHERE elf.event_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_view_files elf
            LEFT JOIN file_metadata fm
              ON fm.owner_id = e.owner_id
             AND fm.s3_key = u.uuid || '/' || elf.video_rel_path
           WHERE elf.event_id = e.id
             AND (fm.id IS NULL
                  OR fm.processing_state <> 'ready')
        )
      LIMIT $1`;

// sql-tag form for the production path — params bound inline.
const ownersWithStalePlaybackReadySql = (limit: number) => sql`
  SELECT DISTINCT e.owner_id
       FROM events e
       JOIN users u ON u.id = e.owner_id
      WHERE e.playback_ready = FALSE
        AND e.playback_unplayable = FALSE
        AND EXISTS (
          SELECT 1 FROM event_view_files elf WHERE elf.event_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM event_view_files elf
            LEFT JOIN file_metadata fm
              ON fm.owner_id = e.owner_id
             AND fm.s3_key = u.uuid || '/' || elf.video_rel_path
           WHERE elf.event_id = e.id
             AND (fm.id IS NULL
                  OR fm.processing_state <> 'ready')
        )
      LIMIT ${limit}
`;

/**
 * DISTINCT owner ids that have at least one stale not-ready event (see the
 * SQL comment above for the exact predicate). Consumed by the reconciler,
 * which recomputes playback_ready per owner — after a recompute the owner's
 * stale events flip ready and stop matching, so the sweep self-quiesces.
 */
export async function getOwnersWithStalePlaybackReady(
  limit = 50,
  client?: import('pg').PoolClient,
): Promise<number[]> {
  // Test override: caller already owns a session with a custom search_path.
  if (client) {
    const r = await client.query<{ owner_id: number }>(
      OWNERS_WITH_STALE_PLAYBACK_READY_SQL,
      [limit],
    );
    return r.rows.map(row => Number(row.owner_id));
  }
  const result = await db.execute<{ owner_id: number }>(
    ownersWithStalePlaybackReadySql(limit),
  );
  return result.rows.map(row => Number(row.owner_id));
}

// ==== Events: getProcessingStatus (window func + filtering) ====

export async function getProcessingStatus(
  userId: number,
  client?: import('pg').PoolClient,
): Promise<ProcessingStatus> {
  // Keep on raw query — uses COUNT(*) OVER () window function.
  // Filtering is now handled by processing_state = 'pending_sidecar' (migration 0007).
  const { pool } = await import('../index.js');
  const exec = client ?? pool;
  const progressRes = await exec.query(
    `SELECT id, original_filename AS filename, uploaded_at AS "uploadedAt",
            COUNT(*) OVER () AS total
       FROM file_metadata
      WHERE owner_id = $1
        AND processing_state = 'pending_sidecar'
      ORDER BY uploaded_at DESC
      LIMIT $2`,
    [userId, PROCESSING_LIST_LIMIT],
  );
  const total = progressRes.rows.length > 0
    ? Number(progressRes.rows[0].total)
    : 0;
  return {
    inProgressCount: total,
    inProgressFiles: progressRes.rows.map((row: { filename: string; uploadedAt: Date | string }) => ({
      filename: String(row.filename),
      uploadedAt:
        row.uploadedAt instanceof Date
          ? row.uploadedAt.toISOString()
          : String(row.uploadedAt),
    })),
  };
}

// ==== File_metadata: CRUD ====

export async function trackFileUpload(
  ownerId: number,
  s3Bucket: string,
  s3Key: string,
  originalFilename: string,
  fileSizeBytes: number,
  uploadedAt: Date,
  truncated = false,
): Promise<{ id: number; inserted: boolean }> {
  // Classify the initial processing_state at insert time so the state column
  // stays authoritative for the banner (which now filters ONLY on
  // processing_state='pending_sidecar', no extension regex). This is the
  // storage-reconciler backfill + legacy /file-uploaded inserter; without
  // this, non-video keys (camera snapshot JPGs, etc.) land at the column
  // DEFAULT 'pending_sidecar' and phantom-inflate "Przetwarzanie plików: N"
  // until the 6h audit drives them to not_applicable. Video keys keep
  // pending_sidecar so the worker/redrive pick them up. ON CONFLICT does NOT
  // touch processing_state — a row already mid-processing must not be reset.
  const ext = s3Key.toLowerCase().replace(/.*\./, '');
  const isVideo = !s3Key.endsWith('/')
    && (PROCESSING_VIDEO_EXTS as readonly string[]).includes(ext);
  const initialState = isVideo ? 'pending_sidecar' : 'not_applicable';
  // ON CONFLICT ... RETURNING (xmax = 0) requires raw sql — Drizzle's onConflictDoUpdate
  // doesn't expose xmax. Keep minimal raw sql just for the RETURNING clause.
  // `truncated` IS overwritten on conflict (unlike processing_state): the
  // flag describes the object currently in the bucket, and a re-upload of the
  // same key replaces those bytes. A camera that finally lands a full file
  // must clear the flag, and a second cut-short attempt must re-set it.
  const r = await db.execute<{ id: number; inserted: boolean }>(sql`
    INSERT INTO file_metadata
      (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, uploaded_at, processing_state, truncated)
    VALUES (${ownerId}, ${s3Bucket}, ${s3Key}, ${originalFilename}, ${fileSizeBytes}, ${uploadedAt}, ${initialState}, ${truncated})
    ON CONFLICT (s3_bucket, s3_key) DO UPDATE SET
      file_size_bytes = EXCLUDED.file_size_bytes,
      original_filename = EXCLUDED.original_filename,
      truncated = EXCLUDED.truncated
    RETURNING id, (xmax = 0) AS inserted
  `);
  return { id: r.rows[0].id, inserted: r.rows[0].inserted as boolean };
}

export async function removeFileMetadata(s3Bucket: string, s3Key: string): Promise<void> {
  await db
    .delete(fileMetadata)
    .where(and(eq(fileMetadata.s3Bucket, s3Bucket), eq(fileMetadata.s3Key, s3Key)));
}

export async function deleteFileMetadataReturningSize(
  ownerId: number,
  s3Bucket: string,
  s3Key: string,
): Promise<{ deleted: boolean; fileSizeBytes: number | null }> {
  const [row] = await db
    .delete(fileMetadata)
    .where(
      and(
        eq(fileMetadata.ownerId, ownerId),
        eq(fileMetadata.s3Bucket, s3Bucket),
        eq(fileMetadata.s3Key, s3Key),
      ),
    )
    .returning({ fileSizeBytes: fileMetadata.fileSizeBytes });

  if (!row) return { deleted: false, fileSizeBytes: null };
  return { deleted: true, fileSizeBytes: Number(row.fileSizeBytes) };
}

export async function deleteFileMetadataByOwner(ownerId: number): Promise<number> {
  const rows = await db
    .delete(fileMetadata)
    .where(eq(fileMetadata.ownerId, ownerId))
    .returning({ id: fileMetadata.id });
  return rows.length;
}

/** Delete all events for a user. Returns the count of deleted rows. */
export async function deleteEventsByOwner(ownerId: number): Promise<number> {
  const result = await db.delete(events).where(eq(events.ownerId, ownerId));
  return result.rowCount ?? 0;
}

export async function getFileMetadataSize(
  ownerId: number,
  s3Bucket: string,
  s3Key: string,
): Promise<number | null> {
  const [row] = await db
    .select({ fileSizeBytes: fileMetadata.fileSizeBytes })
    .from(fileMetadata)
    .where(
      and(
        eq(fileMetadata.ownerId, ownerId),
        eq(fileMetadata.s3Bucket, s3Bucket),
        eq(fileMetadata.s3Key, s3Key),
      ),
    );
  if (!row) return null;
  return Number(row.fileSizeBytes);
}

/**
 * Does ANY live file_metadata row sit under `s3KeyPrefix`?
 *
 * Used by the orphan sweep to decide whether an FTPS folder marker (a 0-byte
 * key ending in `/`) still has live content beneath it. `LIMIT 1` — this is an
 * existence check, never a count, and it runs once per candidate marker.
 *
 * The prefix is escaped for LIKE because S3 keys legitimately contain `_`
 * (camera names are `Front_00_2026…`), which LIKE reads as "any one character".
 * Unescaped, a marker could be spared on the strength of a NEARBY key that
 * merely matched the wildcard — a silent no-op indistinguishable from the very
 * bug this branch exists to fix.
 */
export async function hasFileMetadataUnderPrefix(
  s3Bucket: string,
  s3KeyPrefix: string,
): Promise<boolean> {
  const escaped = s3KeyPrefix.replace(/([\\%_])/g, '\\$1');
  const [row] = await db
    .select({ id: fileMetadata.id })
    .from(fileMetadata)
    .where(
      and(
        eq(fileMetadata.s3Bucket, s3Bucket),
        sql`${fileMetadata.s3Key} LIKE ${escaped + '%'}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function getFileMetadataByKey(
  s3Bucket: string,
  s3Key: string,
): Promise<FileMetaRow | null> {
  const [row] = await db
    .select({
      id: fileMetadata.id,
      ownerId: fileMetadata.ownerId,
      s3Bucket: fileMetadata.s3Bucket,
      s3Key: fileMetadata.s3Key,
      originalFilename: fileMetadata.originalFilename,
      fileSizeBytes: fileMetadata.fileSizeBytes,
      uploadedAt: fileMetadata.uploadedAt,
    })
    .from(fileMetadata)
    .where(and(eq(fileMetadata.s3Bucket, s3Bucket), eq(fileMetadata.s3Key, s3Key)));

  if (!row) return null;
  return mapFileMetaRow(row);
}

export async function getFileMetadataById(
  id: number,
): Promise<FileMetaRow | null> {
  const [row] = await db
    .select({
      id: fileMetadata.id,
      ownerId: fileMetadata.ownerId,
      s3Bucket: fileMetadata.s3Bucket,
      s3Key: fileMetadata.s3Key,
      originalFilename: fileMetadata.originalFilename,
      fileSizeBytes: fileMetadata.fileSizeBytes,
      uploadedAt: fileMetadata.uploadedAt,
    })
    .from(fileMetadata)
    .where(eq(fileMetadata.id, id));

  if (!row) return null;
  return mapFileMetaRow(row);
}

export async function getFileMetadataKeysByOwner(
  ownerId: number,
  olderThanMinutes = 0,
): Promise<{ id: number; s3Bucket: string; s3Key: string }[]> {
  const rows = await db.execute<{ id: number; s3_bucket: string; s3_key: string }>(sql`
    SELECT id, s3_bucket, s3_key FROM file_metadata
     WHERE owner_id = ${ownerId}
       AND uploaded_at < NOW() - (${String(olderThanMinutes)} || ' minutes')::interval
  `);
  return rows.rows.map(row => ({
    id: Number(row.id),
    s3Bucket: row.s3_bucket,
    s3Key: row.s3_key,
  }));
}

export async function getOldestFileForUser(ownerId: number): Promise<FileMetaRow | null> {
  const [row] = await db
    .select({
      id: fileMetadata.id,
      ownerId: fileMetadata.ownerId,
      s3Bucket: fileMetadata.s3Bucket,
      s3Key: fileMetadata.s3Key,
      originalFilename: fileMetadata.originalFilename,
      fileSizeBytes: fileMetadata.fileSizeBytes,
      uploadedAt: fileMetadata.uploadedAt,
    })
    .from(fileMetadata)
    .where(eq(fileMetadata.ownerId, ownerId))
    .orderBy(asc(fileMetadata.uploadedAt), asc(fileMetadata.id))
    .limit(1);

  if (!row) return null;
  return mapFileMetaRow(row);
}

export async function getOldestFileOlderThan(ownerId: number, cutoff: Date): Promise<FileMetaRow | null> {
  const [row] = await db
    .select({
      id: fileMetadata.id,
      ownerId: fileMetadata.ownerId,
      s3Bucket: fileMetadata.s3Bucket,
      s3Key: fileMetadata.s3Key,
      originalFilename: fileMetadata.originalFilename,
      fileSizeBytes: fileMetadata.fileSizeBytes,
      uploadedAt: fileMetadata.uploadedAt,
    })
    .from(fileMetadata)
    .where(and(eq(fileMetadata.ownerId, ownerId), lt(fileMetadata.uploadedAt, cutoff)))
    .orderBy(asc(fileMetadata.uploadedAt), asc(fileMetadata.id))
    .limit(1);

  if (!row) return null;
  return mapFileMetaRow(row);
}

export async function getRecentUploadAvgBytes(
  ownerId: number,
  limit = 50,
): Promise<number | null> {
  // Subquery with LIMIT then AVG — keep on sql tag for the subquery form
  const result = await db.execute<{ avg_bytes: string | null }>(sql`
    SELECT AVG(file_size_bytes)::bigint AS avg_bytes
      FROM (
        SELECT file_size_bytes
          FROM file_metadata
         WHERE owner_id = ${ownerId}
         ORDER BY uploaded_at DESC
         LIMIT ${limit}
      ) recent
  `);
  const avg = result.rows[0]?.avg_bytes;
  return avg == null ? null : Number(avg);
}

export async function findEventsReferencingS3Key(
  ownerId: number,
  s3Key: string,
  userUuid: string,
): Promise<CameraEvent[]> {
  const prefix = `${userUuid}/`;
  const rel = s3Key.startsWith(prefix) ? s3Key.slice(prefix.length) : s3Key;
  const result = await db.execute<{
    id: string; camera: string; timestamp: string; date: string;
    thumbnail: string | null; duration: number | null; owner_id: number;
    views: CameraEvent['views'] | null;
  }>(sql`
    SELECT e.id, e.camera, e.timestamp, e.date, e.thumbnail, e.duration, e.owner_id,
           COALESCE(
             (SELECT json_agg(
                json_build_object(
                  'id', elf.view_id,
                  'videoRelPath', elf.video_rel_path,
                  'durationMs', elf.duration_ms,
                  'sizeBytes', elf.size_bytes,
                  'frameRate', CASE WHEN elf.frame_rate > 0 THEN elf.frame_rate END
                ) ORDER BY elf.view_id
              )
              FROM event_view_files elf WHERE elf.event_id = e.id),
             '[]'::json
           ) AS views
      FROM events e
     WHERE e.owner_id = ${ownerId}
       AND (${rel} = e.thumbnail
            OR EXISTS (
              SELECT 1 FROM event_view_files elf2
               WHERE elf2.event_id = e.id AND elf2.video_rel_path = ${rel}
            ))
  `);
  return result.rows.map(r => ({
    id: r.id, camera: r.camera, timestamp: r.timestamp, date: r.date,
    views: (r.views ?? []) as CameraEvent['views'],
    thumbnail: r.thumbnail,
    duration: r.duration ?? undefined, ownerId: r.owner_id,
  }));
}

export async function getUserFileCount(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ cnt: sql<string>`COUNT(*)` })
    .from(fileMetadata)
    .where(eq(fileMetadata.ownerId, ownerId));
  return parseInt(row?.cnt ?? '0', 10);
}

// ==== Events: delete-notify helpers ====

/**
 * Remove a deleted file's reference from whatever event actually holds it, then
 * delete the event if no view files remain. Located by the AUTHORITATIVE
 * linkage — `event_view_files.video_rel_path` — NOT by deriving the eventId
 * from the filename (which `parseS3KeyForDelete` does and which the retired
 * filename-derived delete path trusted).
 *
 * Why this matters: a proximity-merged dual-view event keeps the EARLIER view's
 * tsRaw as its id, so the LATER view's file lives on an event whose id ≠ the id
 * derived from that file's own name. The derive-then-target path therefore
 * no-op'd on the merged view → the file's `file_metadata` was removed but the
 * `event_view_files` row + the event were orphaned (shows as 0 B with a
 * residual event in the UI). A full FTPS cleanup left events behind, all
 * with elf paths whose tsRaw was 1 s off the
 * event id. The retired scanner used to mask this by rebuilding events from S3.
 *
 * Returns the ids of events actually deleted so the caller can clean their
 * generated thumbnails + notifications.
 */
export async function removeDeletedFileFromEvents(
  ownerId: number,
  deletedRelKey: string,
): Promise<{ deletedEventIds: string[] }> {
  return withTx(async (tx) => {
    // Native-sidecar thumbnail that pointed at the deleted file → clear it.
    await tx.execute(sql`
      UPDATE events SET thumbnail = NULL
       WHERE owner_id = ${ownerId} AND thumbnail = ${deletedRelKey}
    `);

    // Authoritative lookup: which event(s) actually reference this file?
    const holders = await tx.execute<{ event_id: string }>(sql`
      SELECT DISTINCT elf.event_id
        FROM event_view_files elf
        JOIN events e ON e.id = elf.event_id
       WHERE e.owner_id = ${ownerId} AND elf.video_rel_path = ${deletedRelKey}
    `);

    const deletedEventIds: string[] = [];
    for (const { event_id } of holders.rows) {
      // Serialize with the sibling view's delete-notify for the SAME event so a
      // concurrently-deleted dual-view pair can't leave the row un-deleted
      // (both messages racing the remaining-views check). xact-scoped: released
      // on commit of this withTx.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${DELETE_BY_PATH_LOCK_KEY1}, hashtext(${event_id}))`,
      );
      await tx.execute(sql`
        DELETE FROM event_view_files
         WHERE event_id = ${event_id} AND video_rel_path = ${deletedRelKey}
      `);
      const remaining = await tx.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM event_view_files WHERE event_id = ${event_id} LIMIT 1
      `);
      if (remaining.rows.length === 0) {
        await tx.execute(sql`DELETE FROM events WHERE id = ${event_id} AND owner_id = ${ownerId}`);
        deletedEventIds.push(event_id);
      }
    }
    return { deletedEventIds };
  });
}

/**
 * Direct slot overwrite for an event row, bypassing the COALESCE rules in
 * `upsertEventsDelta`. Used by `reconcileCrossScanSlots` to heal dual-view
 * merge artifacts.
 *
 * Why a separate primitive: `upsertEventsDelta`'s `ON CONFLICT DO UPDATE`
 * uses `COALESCE(events.<slot>_video, EXCLUDED.<slot>_video)` to enforce
 * first-wins for the genuine-duplicate case. When the existing DB cell is
 * non-null, that COALESCE silently rejects any new value — which is correct
 * for true cross-scan duplicates but wrong for merge artifacts where the
 * existing cell points at a foreign-tsRaw file that needs to be replaced
 * by the legitimate partner. This function writes the new value directly
 * with no COALESCE.
 *
 * Scoped by (eventId, ownerId). Returns silently when no row matches —
 * idempotent against a race with `removeDeletedFileFromEvents` or
 * a concurrent full-rebuild.
 */
/**
 * Direct slot overwrite for an event's view file, bypassing COALESCE rules in
 * `upsertEventsDelta`. Used by `reconcileCrossScanSlots` to heal dual-view
 * merge artifacts.
 *
 * v10: writes to event_view_files (event_id, view_id, video_rel_path).
 * Ownership is enforced via a SELECT subquery on events.owner_id.
 */
export async function healEventSlot(
  ownerId: number,
  eventId: string,
  viewId: string,
  newPath: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO event_view_files (event_id, view_id, video_rel_path)
      SELECT id, ${viewId}, ${newPath} FROM events WHERE id = ${eventId} AND owner_id = ${ownerId}
    ON CONFLICT (event_id, view_id) DO UPDATE SET video_rel_path = EXCLUDED.video_rel_path
  `);
}

// ==== Backfill helpers ====

export interface ClassAViewRow {
  /** event_view_files primary key — used as the keyset cursor */
  eventId: string;
  viewId: string;
  videoRelPath: string;
  s3Key: string;
  encryptionSalt: string | null;
}

/**
 * Keyset-paginated page of class-A (patch-ready) view-file rows for the
 * frame-grid backfill script. Returns rows where `fm.processing_state = 'ready'`
 * (class A means the sidecar pipeline finished successfully).
 *
 * Unlike `getViewsMissingFrameRate` there is NO `frame_rate IS NULL` predicate
 * here — the script cannot filter in SQL because `.frames` existence is only
 * knowable via S3 HEAD; it pages all class-A rows and lets the HEAD check
 * provide idempotency / resumability.
 *
 * Cursor: `(event_id, view_id)` — the composite PK of `event_view_files`.
 * Ascending order so the cursor strictly advances and the run terminates.
 */
export async function getClassAViewsAfter(
  cursor: { eventId: string; viewId: string } | null,
  limit: number,
): Promise<ClassAViewRow[]> {
  const result = await db.execute<{
    eventId: string;
    viewId: string;
    videoRelPath: string;
    s3Key: string;
    encryptionSalt: string | null;
  }>(sql`
    SELECT elf.event_id AS "eventId", elf.view_id AS "viewId",
           elf.video_rel_path AS "videoRelPath", fm.s3_key AS "s3Key",
           u.encryption_salt AS "encryptionSalt"
      FROM event_view_files elf
      JOIN events e ON e.id = elf.event_id
      JOIN users u ON u.id = e.owner_id
      JOIN file_metadata fm
        ON fm.owner_id = e.owner_id
       AND fm.s3_key = u.uuid || '/' || elf.video_rel_path
     WHERE fm.processing_state = 'ready'
       ${cursor
         ? sql`AND (elf.event_id, elf.view_id) > (${cursor.eventId}, ${cursor.viewId})`
         : sql``}
     ORDER BY elf.event_id ASC, elf.view_id ASC
     LIMIT ${limit}
  `);
  return result.rows;
}
