import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { users } from './users.js';

// ---------------------------------------------------------------------------
// storage_reconciliation_runs — one row per reconciler execution
// ---------------------------------------------------------------------------
export const storageReconciliationRuns = pgTable('storage_reconciliation_runs', {
  id: serial('id').primaryKey(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  usersChecked: integer('users_checked').notNull().default(0),
  correctionsMade: integer('corrections_made').notNull().default(0),
  orphansFound: integer('orphans_found').notNull().default(0),
  orphanBytesTotal: bigint('orphan_bytes_total', { mode: 'number' }).notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  // Added via ALTER TABLE — zombie-event tracking
  zombiesCleaned: integer('zombies_cleaned').notNull().default(0),
  zombiesRemaining: integer('zombies_remaining').notNull().default(0),
  // Added via ALTER TABLE — event↔S3 consistency sweep
  eventsReconciled: integer('events_reconciled').notNull().default(0),
  eventsDeleted: integer('events_deleted').notNull().default(0),
});

// ---------------------------------------------------------------------------
// storage_disk_corrections — per-user disk-usage correction audit rows
// ---------------------------------------------------------------------------
export const storageDiskCorrections = pgTable(
  'storage_disk_corrections',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => storageReconciliationRuns.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Denormalized user email at time of correction (survives user deletion)
    email: text('email').notNull(),
    oldBytes: bigint('old_bytes', { mode: 'number' }).notNull(),
    newBytes: bigint('new_bytes', { mode: 'number' }).notNull(),
    deltaBytes: bigint('delta_bytes', { mode: 'number' }).notNull(),
    correctedAt: timestamp('corrected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index('idx_disk_corrections_run').on(table.runId),
    userIdx: index('idx_disk_corrections_user').on(table.userId),
  }),
);

// ---------------------------------------------------------------------------
// storage_orphan_objects — S3 objects with no corresponding DB row
// ---------------------------------------------------------------------------
export const storageOrphanObjects = pgTable(
  'storage_orphan_objects',
  {
    id: serial('id').primaryKey(),
    s3Bucket: text('s3_bucket').notNull(),
    s3Key: text('s3_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    seenCount: integer('seen_count').notNull().default(1),
    acknowledged: boolean('acknowledged').notNull().default(false),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: integer('acknowledged_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    s3BucketKeyUniq: uniqueIndex('storage_orphan_objects_s3_bucket_s3_key_key').on(
      table.s3Bucket,
      table.s3Key,
    ),
    acknowledgedIdx: index('idx_orphans_acknowledged').on(table.acknowledged),
  }),
);

// ---------------------------------------------------------------------------
// upload_events — rolling 30-day upload log (per-upload row, pruned by reconciler)
// ---------------------------------------------------------------------------
export const uploadEvents = pgTable(
  'upload_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bytesCheck: check('upload_events_bytes_check', sql`${table.bytes} >= 0`),
    userTimeIdx: index('idx_upload_events_user_time').on(table.userId, table.uploadedAt.desc()),
    uploadedAtIdx: index('idx_upload_events_uploaded_at').on(table.uploadedAt),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type StorageReconciliationRun = typeof storageReconciliationRuns.$inferSelect;
export type NewStorageReconciliationRun = typeof storageReconciliationRuns.$inferInsert;

export type StorageDiskCorrection = typeof storageDiskCorrections.$inferSelect;
export type NewStorageDiskCorrection = typeof storageDiskCorrections.$inferInsert;

export type StorageOrphanObject = typeof storageOrphanObjects.$inferSelect;
export type NewStorageOrphanObject = typeof storageOrphanObjects.$inferInsert;

export type UploadEvent = typeof uploadEvents.$inferSelect;
export type NewUploadEvent = typeof uploadEvents.$inferInsert;
