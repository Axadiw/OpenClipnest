import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
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

// content_deletions — one lock episode per account whose access ended for
// lack of an active plan: when its recordings may be deleted, an
// administrator's hold, and the point of no return (started_at: only content
// older than it is deleted, so what is uploaded after a payment survives).
export type HoldReason = 'admin' | 'undeliverable';
export const contentDeletions = pgTable('content_deletions', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  lockStartedAt: timestamp('lock_started_at', { withTimezone: true }).notNull(),
  deleteAfter: timestamp('delete_after', { withTimezone: true }).notNull(),
  heldAt: timestamp('held_at', { withTimezone: true }),
  heldBy: integer('held_by').references(() => users.id, { onDelete: 'set null' }),
  holdNote: text('hold_note'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  objectsRemoved: integer('objects_removed').notNull().default(0),
  rowsRemoved: integer('rows_removed').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  noticeRefAt: timestamp('notice_ref_at', { withTimezone: true }),
  firstStatedAt: timestamp('first_stated_at', { withTimezone: true }),
  holdReason: text('hold_reason').$type<HoldReason>(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
}, (t) => ({
  holdReasonCheck: check('content_deletions_hold_reason_check',
    sql`${t.holdReason} IS NULL OR ${t.holdReason} IN ('admin', 'undeliverable')`),
}));

// content_deletion_runs — one row per run of the daily job; a row without
// finished_at is a run that was killed before it ended.
export const contentDeletionRuns = pgTable('content_deletion_runs', {
  id: serial('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  mode: text('mode').notNull(),
  candidates: integer('candidates').notNull().default(0),
  firstNotices: integer('first_notices').notNull().default(0),
  finalNotices: integer('final_notices').notNull().default(0),
  due: integer('due').notNull().default(0),
  deleted: integer('deleted').notNull().default(0),
  resumed: integer('resumed').notNull().default(0),
  held: integer('held').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  // Accounts due this run but left for a later day by the per-run limit.
  deferred: integer('deferred').notNull().default(0),
  truncated: boolean('truncated').notNull().default(false),
  renotices: integer('renotices').notNull().default(0),
  holdsReleased: integer('holds_released').notNull().default(0),
});

// account_notices — each notice sent to an account, once per (kind, reference
// time): the lock start for the first notice and the completion notice, the
// deletion date for the final one (a postponed date gets a new final notice).
export const ACCOUNT_NOTICE_KINDS = ['content_deletion_first', 'content_deletion_final', 'content_deleted'] as const;
export type AccountNoticeKind = (typeof ACCOUNT_NOTICE_KINDS)[number];
export const accountNotices = pgTable(
  'account_notices',
  {
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AccountNoticeKind>().notNull(),
    refAt: timestamp('ref_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    providerMessageId: text('provider_message_id'),
  },
  (table) => ({
    messageIdx: index('account_notices_message_idx').on(table.providerMessageId).where(sql`${table.providerMessageId} IS NOT NULL`),
    pk: primaryKey({ name: 'account_notices_pkey', columns: [table.userId, table.kind, table.refAt] }),
    kindCheck: check('account_notices_kind_check',
      sql`${table.kind} IN ('content_deletion_first', 'content_deletion_final', 'content_deleted')`),
  }),
);
