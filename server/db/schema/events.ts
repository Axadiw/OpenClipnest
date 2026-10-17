import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';

// ---------------------------------------------------------------------------
// file_metadata — one row per uploaded MP4 (or any raw file)
// ---------------------------------------------------------------------------
export const fileMetadata = pgTable(
  'file_metadata',
  {
    id: serial('id').primaryKey(),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    s3Bucket: text('s3_bucket').notNull(),
    s3Key: text('s3_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    // Explicit state machine (migration 0008). One of: pending_sidecar |
    // ready | unplayable | duplicate | unrecognized | not_applicable.
    processingState: text('processing_state').notNull().default('pending_sidecar'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    // Retry attempts counter for exponential backoff (migration 0009).
    // Replaces legacy playback_patch_attempts dropped in the same migration.
    processingAttempts: integer('processing_attempts').notNull().default(0),
    // The client cut this upload short (migration 0015). FTPS commits the
    // bytes that did arrive rather than discarding them, so the object is a
    // valid but SHORTER clip than the camera recorded. Reset to false when
    // the same s3_key is later re-uploaded in full.
    truncated: boolean('truncated').notNull().default(false),
  },
  (table) => ({
    s3BucketKeyUniq: uniqueIndex('file_metadata_s3_bucket_s3_key_key').on(
      table.s3Bucket,
      table.s3Key,
    ),
    ownerIdx: index('idx_file_metadata_owner').on(table.ownerId),
    ownerUploadedIdx: index('idx_file_metadata_owner_uploaded').on(
      table.ownerId,
      table.uploadedAt,
    ),
    ownerS3KeyIdx: index('idx_file_metadata_owner_s3key').on(table.ownerId, table.s3Key),
    ownerStatePendingIdx: index('idx_file_metadata_owner_state_pending')
      .on(table.ownerId)
      .where(sql`${table.processingState} = 'pending_sidecar'`),
    redriveIdx: index('idx_file_metadata_redrive')
      .on(table.nextRetryAt)
      .where(sql`${table.processingState} = 'pending_sidecar'`),
    processingStateCheck: check(
      'file_metadata_processing_state_check',
      sql`${table.processingState} IN ('pending_sidecar','ready','unplayable','duplicate','unrecognized','not_applicable')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// events — one row per camera event (v10: wide_video/zoom_video removed;
// per-file attachments live in event_view_files)
// ---------------------------------------------------------------------------
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    camera: text('camera').notNull(),
    timestamp: text('timestamp').notNull(),
    date: text('date').notNull(),
    thumbnail: text('thumbnail'),
    duration: real('duration'),
    ownerId: integer('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    // Added via ALTER TABLE — thumbnail processing
    thumbnailAttempts: integer('thumbnail_attempts').notNull().default(0),
    // Added via ALTER TABLE — event-level visibility gate
    playbackReady: boolean('playback_ready').notNull().default(false),
    // Added via ALTER TABLE — denormalised permanent failure flag
    playbackUnplayable: boolean('playback_unplayable').notNull().default(false),
    // Added via ALTER TABLE — ingest timestamp (when the scanner first created
    // this row), distinct from `timestamp` (camera capture time, from filename).
    // Observability only — NOT used for the new_recording decision (capture
    // time is the correct freshness signal). Nullable: rows predating the
    // column stay NULL; new inserts get now() via the DB default.
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    timestampIdx: index('idx_events_timestamp').on(table.timestamp.desc()),
    cameraIdx: index('idx_events_camera').on(table.camera),
    ownerIdx: index('idx_events_owner').on(table.ownerId),
    ownerCameraIdx: index('idx_events_owner_camera').on(table.ownerId, table.camera),
  }),
);

// ---------------------------------------------------------------------------
// event_view_files — per-view file attachments for each event (v10)
// Replaces the legacy wide_video / zoom_video columns on the events table.
// ---------------------------------------------------------------------------
export const eventViewFiles = pgTable(
  'event_view_files',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    // view_id is the view identifier (e.g. '00', '01', or arbitrary strings
    // for custom profiles). Renamed from lens_id in migration 0002.
    viewId: text('view_id').notNull(),
    videoRelPath: text('video_rel_path').notNull(),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    frameRate: real('frame_rate'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventId, table.viewId] }),
    // Forward lookup: all files for a given event
    eventIdx: index('idx_event_view_files_event').on(table.eventId),
    // Reverse lookup: given a rel_path, which events reference it?
    pathIdx: index('idx_event_view_files_path').on(table.videoRelPath),
  }),
);

// ---------------------------------------------------------------------------
// user_scan_state — incremental scanner high-water mark per user
// ---------------------------------------------------------------------------
export const userScanState = pgTable('user_scan_state', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }).notNull(),
  lastSeenS3Key: text('last_seen_s3_key'),
  fullRescanDueAt: timestamp('full_rescan_due_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// user_camera_profiles — custom filename-matching profiles per user
// ---------------------------------------------------------------------------
export const userCameraProfiles = pgTable(
  'user_camera_profiles',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    regex: text('regex').notNull(),
    // v10: relaxed from IN ('00','01') to length 1..16 to support custom
    // profile view identifiers beyond Reolink's two-channel schema.
    viewDefault: text('view_default').notNull().default('00'),
    // v11: per-view icon personalization. Ordered array of {id, iconKind}
    // entries; the first entry is the primary view and mirrors view_default.
    // Default '[]' so the migration backfill can detect untouched rows.
    viewsConfig: jsonb('views_config').$type<Array<{ id: string; iconKind: string }>>().notNull().default([]),
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userPriorityIdx: index('idx_user_camera_profiles_user_priority').on(
      table.userId,
      table.priority,
    ),
    viewDefaultCheck: check(
      'user_camera_profiles_view_default_check',
      sql`length(${table.viewDefault}) BETWEEN 1 AND 16`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type FileMetadata = typeof fileMetadata.$inferSelect;
export type NewFileMetadata = typeof fileMetadata.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type EventViewFile = typeof eventViewFiles.$inferSelect;
export type NewEventViewFile = typeof eventViewFiles.$inferInsert;

export type UserScanState = typeof userScanState.$inferSelect;
export type NewUserScanState = typeof userScanState.$inferInsert;

export type UserCameraProfile = typeof userCameraProfiles.$inferSelect;
export type NewUserCameraProfile = typeof userCameraProfiles.$inferInsert;
