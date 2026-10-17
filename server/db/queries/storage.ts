// server/db/queries/storage.ts
import { eq, and, sql } from 'drizzle-orm';
import { db, withTx, LOCK_NS_QUOTA, userLockKey } from '../index.js';
import {
  uploadEvents, storageReconciliationRuns, storageDiskCorrections, storageOrphanObjects,
  userScanState, users, plans,
  type StorageOrphanObject,
} from '../schema/index.js';
import type { UserQuota } from '../../types.js';
import { displayableEventPredicateSql } from './events.js';

// Patterns reference: server/db/queries/users.ts (top of file)

// ==== Quota & disk usage: simple ====

/**
 * Atomically update a user's disk usage by a delta (positive or negative).
 */
export async function updateDiskUsage(userId: number, deltaBytes: number): Promise<void> {
  await db
    .update(users)
    .set({ diskUsageBytes: sql`GREATEST(0, ${users.diskUsageBytes} + ${deltaBytes})` })
    .where(eq(users.id, userId));
}

/**
 * Read a user's current disk_usage_bytes — fresh from the row, no cache.
 * Used by the quota-tidy loop to recheck progress after each evictFile()
 * and stop as soon as we're back under plan.
 */
export async function getDiskUsage(userId: number): Promise<number> {
  const [row] = await db
    .select({ diskUsageBytes: users.diskUsageBytes })
    .from(users)
    .where(eq(users.id, userId));
  return row ? row.diskUsageBytes : 0;
}

/**
 * Find every user whose `disk_usage_bytes` currently sits above their plan
 * limit AND who has opted into auto-delete. The cron sweep iterates this
 * list and calls `evictUserToFitPlan` on each one as a belt-and-suspenders
 * safety net for cases where the post-upload trigger never fired (FTPS
 * crash, scheduled flag toggle, drift from `setDiskUsageAbsolute` healing).
 * Plans with `disk_space_bytes = 0` (unlimited) are excluded.
 */
export async function getUsersOverQuotaWithAutoDelete(): Promise<
  Array<{ id: number; uuid: string; encryptionSalt: string; overBytes: number }>
> {
  const rows = await db
    .select({
      id: users.id,
      uuid: users.uuid,
      encryptionSalt: users.encryptionSalt,
      overBytes: sql<number>`(${users.diskUsageBytes} - ${plans.diskSpaceBytes})`,
    })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(
      and(
        eq(users.autoDeleteOldest, true),
        sql`${plans.diskSpaceBytes} > 0`,
        sql`${users.diskUsageBytes} > ${plans.diskSpaceBytes}`,
        sql`${users.encryptionSalt} IS NOT NULL`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    encryptionSalt: r.encryptionSalt as string,
    overBytes: Number(r.overBytes),
  }));
}

/**
 * Every non-admin user assigned to `planId` (with a provisioned encryption
 * salt), tagged with their `auto_delete_oldest` flag. Used by
 * `runQuotaTidyForPlan` to fan out instant eviction + quota warnings the moment
 * an admin shrinks a plan's storage limit, instead of waiting for the 1-min
 * cron sweep to walk every user and notice. Not filtered on over-quota here —
 * `evictUserToFitPlan`/`reconcileUserQuota` re-check the limit per user, so the
 * caller can stay a simple fan-out.
 */
export async function getUsersByPlan(
  planId: number,
): Promise<Array<{ id: number; uuid: string; encryptionSalt: string; autoDeleteOldest: boolean }>> {
  const rows = await db
    .select({
      id: users.id,
      uuid: users.uuid,
      encryptionSalt: users.encryptionSalt,
      autoDeleteOldest: users.autoDeleteOldest,
    })
    .from(users)
    .where(
      and(
        eq(users.planId, planId),
        eq(users.isAdmin, false),
        sql`${users.encryptionSalt} IS NOT NULL`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    encryptionSalt: r.encryptionSalt as string,
    autoDeleteOldest: r.autoDeleteOldest,
  }));
}

/**
 * Record an accepted FTPS upload — bumps the lifetime counter AND the rolling
 * 30-day counter AND inserts a row into the 30-day log, in a single
 * transaction. Called from `POST /internal/users/:uuid/disk-claim-and-tidy`
 * only on the success path (uploads rolled back due to over-plan + flag-off do
 * NOT count).
 */
export async function recordUpload(userId: number, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await withTx(async (tx) => {
    await tx
      .update(users)
      .set({
        uploadLifetimeBytes: sql`${users.uploadLifetimeBytes} + ${bytes}`,
        upload30dBytes: sql`${users.upload30dBytes} + ${bytes}`,
      })
      .where(eq(users.id, userId));
    await tx.insert(uploadEvents).values({ userId, bytes });
  });
}

/**
 * Reaper for `upload_events` — deletes rows older than the rolling window
 * (30 days) AND decrements each affected user's `upload_30d_bytes` counter by
 * exactly the pruned bytes, in one atomic statement so the counter stays
 * consistent with table membership. Run from the storage reconciler cron
 * sweep. Returns the number of rows pruned for telemetry.
 */
export async function purgeOldUploadEvents(olderThanDays = 30): Promise<number> {
  // Single data-modifying CTE: the DELETE and the counter UPDATE share one
  // snapshot. GREATEST(0, …) clamps the counter so transient drift can never
  // push it negative. The `upd` CTE runs to completion even though the final
  // SELECT only reads `pruned` — Postgres always executes data-modifying CTEs.
  const result = await db.execute<{ id: number }>(sql`
    WITH pruned AS (
      DELETE FROM upload_events
       WHERE uploaded_at < NOW() - (${String(olderThanDays)} || ' days')::interval
      RETURNING user_id, bytes, id
    ),
    agg AS (
      SELECT user_id, SUM(bytes) AS bytes FROM pruned GROUP BY user_id
    ),
    upd AS (
      UPDATE users u
         SET upload_30d_bytes = GREATEST(0, u.upload_30d_bytes - agg.bytes)
        FROM agg
       WHERE u.id = agg.user_id
      RETURNING 1
    )
    SELECT id FROM pruned
  `);
  return result.rows.length;
}

/**
 * Atomically update a user's transfer usage by a delta (always positive for uploads/downloads).
 */
export async function updateTransferUsage(userId: number, deltaBytes: number): Promise<void> {
  await db
    .update(users)
    .set({ transferUsageBytes: sql`${users.transferUsageBytes} + ${Math.max(0, deltaBytes)}` })
    .where(eq(users.id, userId));
}

/**
 * Lazy monthly transfer reset: if transfer_reset_at has passed, reset the counter
 * and set next month's reset date. Returns current transfer values after potential reset.
 */
export async function checkAndResetTransfer(
  userId: number,
): Promise<{ transferUsageBytes: number; transferResetAt: string }> {
  const [row] = await db
    .select({ transferUsageBytes: users.transferUsageBytes, transferResetAt: users.transferResetAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return { transferUsageBytes: 0, transferResetAt: '' };

  const now = new Date();
  const resetAt = row.transferResetAt ? new Date(row.transferResetAt) : null;

  if (!resetAt || resetAt <= now) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    await db
      .update(users)
      .set({ transferUsageBytes: 0, transferResetAt: new Date(nextReset) })
      .where(eq(users.id, userId));
    return { transferUsageBytes: 0, transferResetAt: nextReset };
  }

  return {
    transferUsageBytes: Number(row.transferUsageBytes),
    transferResetAt:
      row.transferResetAt instanceof Date
        ? row.transferResetAt.toISOString()
        : (row.transferResetAt ?? ''),
  };
}

/**
 * Get a user's full quota information including plan limits.
 */
export async function getUserQuota(userId: number): Promise<UserQuota | undefined> {
  const [r] = await db
    .select({
      diskUsageBytes: users.diskUsageBytes,
      transferUsageBytes: users.transferUsageBytes,
      transferResetAt: users.transferResetAt,
      diskSpaceBytes: plans.diskSpaceBytes,
      monthlyTransferBytes: plans.monthlyTransferBytes,
    })
    .from(users)
    .leftJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.id, userId));
  if (!r) return undefined;
  return {
    diskUsageBytes: Number(r.diskUsageBytes),
    diskLimitBytes: r.diskSpaceBytes ? Number(r.diskSpaceBytes) : 0,
    transferUsageBytes: Number(r.transferUsageBytes),
    transferLimitBytes: r.monthlyTransferBytes ? Number(r.monthlyTransferBytes) : 0,
    transferResetAt:
      r.transferResetAt instanceof Date
        ? r.transferResetAt.toISOString()
        : (r.transferResetAt ?? null),
  };
}

// ==== Quota: settings (auto-delete) ====

/**
 * Read the auto-delete-oldest flag for a user.
 */
export async function getAutoDeleteOldest(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ autoDeleteOldest: users.autoDeleteOldest })
    .from(users)
    .where(eq(users.id, userId));
  return !!row?.autoDeleteOldest;
}

/**
 * Toggle the auto-delete-oldest flag. When true, the reconciler removes the
 * oldest events instead of only notifying when the user approaches quota.
 */
export async function setAutoDeleteOldest(userId: number, value: boolean): Promise<void> {
  await db.update(users).set({ autoDeleteOldest: value }).where(eq(users.id, userId));
}

/**
 * Read the per-user retention window in days. NULL means retention is off.
 */
export async function getAutoDeleteAfterDays(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ autoDeleteAfterDays: users.autoDeleteAfterDays })
    .from(users)
    .where(eq(users.id, userId));
  const v = row?.autoDeleteAfterDays;
  return v == null ? null : Number(v);
}

/**
 * Set or clear the retention window. `days = null` disables retention; a
 * positive integer in [1, 365] enables eviction of files older than that
 * window. The API layer is responsible for rejecting out-of-range values.
 */
export async function setAutoDeleteAfterDays(userId: number, days: number | null): Promise<void> {
  await db.update(users).set({ autoDeleteAfterDays: days }).where(eq(users.id, userId));
}

export interface StorageWarnState {
  email: string;
  autoDeleteOldest: boolean;
  autoDeleteAfterDays: number | null;
  storageWarnEmailSentAt: Date | null;
}

/**
 * Single query that returns everything the quota reconciler needs to decide
 * whether to send a storage-warning email: the user's address, both
 * auto-delete flags, and the timestamp of the last warning email.
 */
export async function getStorageWarnState(userId: number): Promise<StorageWarnState | null> {
  const [row] = await db
    .select({
      email: users.email,
      autoDeleteOldest: users.autoDeleteOldest,
      autoDeleteAfterDays: users.autoDeleteAfterDays,
      storageWarnEmailSentAt: users.storageWarnEmailSentAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  return {
    email: row.email,
    autoDeleteOldest: !!row.autoDeleteOldest,
    autoDeleteAfterDays:
      row.autoDeleteAfterDays == null ? null : Number(row.autoDeleteAfterDays),
    storageWarnEmailSentAt:
      row.storageWarnEmailSentAt instanceof Date
        ? row.storageWarnEmailSentAt
        : row.storageWarnEmailSentAt
          ? new Date(row.storageWarnEmailSentAt)
          : null,
  };
}

/**
 * Every non-admin, non-soft-deleted user with a configured retention window.
 * The retention cron iterates this list once per tick.
 */
export async function getUsersWithRetention(): Promise<
  Array<{ id: number; uuid: string; encryptionSalt: string | null; autoDeleteAfterDays: number }>
> {
  const rows = await db
    .select({
      id: users.id,
      uuid: users.uuid,
      encryptionSalt: users.encryptionSalt,
      autoDeleteAfterDays: users.autoDeleteAfterDays,
    })
    .from(users)
    .where(
      and(
        eq(users.isAdmin, false),
        eq(users.deletionStatus, 'active'),
        sql`${users.autoDeleteAfterDays} IS NOT NULL`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    encryptionSalt: r.encryptionSalt,
    autoDeleteAfterDays: Number(r.autoDeleteAfterDays),
  }));
}

export interface CameraDiskUsage {
  cameraName: string;
  bytes: number;
  durationSeconds: number;
  eventCount: number;
}

/**
 * Per-camera disk-usage breakdown for the user. Bytes are summed from
 * `file_metadata.file_size_bytes` joined to `events` via the same
 * `SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) = elf.video_rel_path`
 * idiom (via event_view_files); duration + event count come straight
 * from the events table.
 *
 * Kept as raw sql tag: CTE (WITH cam_events + cam_bytes) pattern that benefits
 * from explicit structuring over Drizzle's query builder.
 */
export async function getDiskUsageByCamera(userId: number): Promise<CameraDiskUsage[]> {
  // v10: JOIN file_metadata via event_view_files instead of wide_video/zoom_video.
  const { pool: rawPool } = await import('../index.js');
  const result = await rawPool.query(
    `WITH cam_events AS (
       SELECT camera,
              -- event_count is shown to the user as "N clips"/"Recordings", so it
              -- must match the canonical *displayable* count rendered by the grid
              -- (getEvents) and the Cameras grid (getCameraDetails). Uses the same
              -- shared predicate so the three counts can't drift (the iOS-vs-web
              -- "7975 vs 7961" report). duration_seconds intentionally counts ALL
              -- events (matches the recorded-hours storage view); bytes (cam_bytes)
              -- likewise stay whole-disk for accurate quota accounting.
              COUNT(*) FILTER (WHERE ${displayableEventPredicateSql('events')}) AS event_count,
              COALESCE(SUM(duration), 0) AS duration_seconds
         FROM events
        WHERE owner_id = $1
        GROUP BY camera
     ),
     cam_bytes AS (
       SELECT e.camera,
              COALESCE(SUM(fm.file_size_bytes), 0) AS bytes
         FROM events e
         JOIN event_view_files elf ON elf.event_id = e.id
         JOIN users u          ON u.id = e.owner_id
         JOIN file_metadata fm ON fm.owner_id = e.owner_id
           AND SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) = elf.video_rel_path
        WHERE e.owner_id = $1
        GROUP BY e.camera
     )
     SELECT ce.camera                              AS camera,
            COALESCE(cb.bytes, 0)::BIGINT          AS bytes,
            ce.duration_seconds::DOUBLE PRECISION  AS duration_seconds,
            ce.event_count::INT                    AS event_count
       FROM cam_events ce
       LEFT JOIN cam_bytes cb ON cb.camera = ce.camera
       ORDER BY bytes DESC NULLS LAST, ce.camera ASC`,
    [userId],
  );
  return result.rows.map((r) => ({
    cameraName: r.camera as string,
    bytes: Number(r.bytes),
    durationSeconds: Number(r.duration_seconds),
    eventCount: Number(r.event_count),
  }));
}

// ==== Quota: advisory-lock primitives ====

/**
 * Atomically claim disk space for an upload.
 * Increments disk_usage_bytes by deltaBytes only if the resulting total
 * would not exceed the plan's disk_space_bytes limit (0 means unlimited).
 * Returns true if the space was claimed, false if quota would be exceeded.
 *
 * This prevents the TOCTOU race where parallel uploads each pass the
 * separate read-check-write pattern and collectively exceed the limit.
 *
 * Kept as raw sql tag: atomic UPDATE … FROM subquery pattern that embeds
 * the quota check inline — no clean Drizzle equivalent for conditional
 * increment via self-join.
 */
export async function atomicClaimDiskSpace(
  userId: number,
  deltaBytes: number,
): Promise<boolean> {
  const { pool: rawPool } = await import('../index.js');
  const result = await rawPool.query(
    `UPDATE users
     SET disk_usage_bytes = disk_usage_bytes + $1
     FROM (
       SELECT u.id, u.disk_usage_bytes AS current_usage, p.disk_space_bytes AS disk_limit
       FROM users u LEFT JOIN plans p ON u.plan_id = p.id
       WHERE u.id = $2
     ) AS quota
     WHERE users.id = quota.id
       AND (quota.disk_limit IS NULL OR quota.disk_limit = 0
            OR quota.current_usage + $1 <= quota.disk_limit)
     RETURNING users.id`,
    [deltaBytes, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Acquire a per-user advisory lock and run `fn` exclusively.
 *
 * Built around `pg_try_advisory_lock` so concurrent callers fail fast
 * instead of queueing — the ones that don't get the lock just skip the
 * critical section. Used by the post-upload + cron-driven quota-tidy
 * eviction so 8 parallel STOR completions don't spawn 8 overlapping
 * eviction loops that race on the same `getOldestFileForUser` rows.
 *
 * Returns `null` when the lock was already held; otherwise the value
 * returned by `fn`.
 *
 * DISTINCT from `withUserLock` (server/db/index.ts): this is a SESSION-LEVEL
 * lock (`pg_try_advisory_lock` / `pg_advisory_unlock`) that survives beyond
 * a single transaction — ideal for long-running eviction loops that span
 * multiple statements and don't want to hold a DB transaction open.
 * `withUserLock` uses `pg_advisory_xact_lock` (transactional, auto-released
 * on COMMIT/ROLLBACK) and is appropriate for short transactional sequences.
 * Callers that need fail-fast non-blocking behavior with multi-statement
 * critical sections (quotaTidy, storageReconciler) must use this function.
 *
 * Kept as raw sql tag: session-level advisory lock requires a dedicated client
 * connection that must outlive any individual transaction.
 */
export async function withUserAdvisoryLock<T>(
  userId: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const { pool: rawPool } = await import('../index.js');
  const client = await rawPool.connect();
  let acquired = false;
  // Namespaced under LOCK_NS_QUOTA so this lock doesn't head-of-line-block the
  // scanner's LOCK_NS_EVENTS lock on the same userId. The two paths touch
  // different rows and never need to mutually exclude.
  const key = userLockKey(LOCK_NS_QUOTA, userId).toString();
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    acquired = !!r.rows[0]?.locked;
    if (!acquired) return null;
    return await fn();
  } finally {
    if (acquired) {
      await client
        .query('SELECT pg_advisory_unlock($1::bigint)', [key])
        .catch((e) => {
          console.error(
            'withUserAdvisoryLock: unlock failed:',
            e instanceof Error ? e.message : e,
          );
        });
    }
    client.release();
  }
}

// ==== Scan & reconciliation ====

// Soft-deleted users are skipped by the scanner — their objects are being
// reaped by the deletion worker and must not re-enter event ingestion.
export interface ScannerUser {
  id: number;
  uuid: string;
  encryptionSalt: string | null;
}

export async function getUsersForScan(): Promise<ScannerUser[]> {
  const rows = await db
    .select({ id: users.id, uuid: users.uuid, encryptionSalt: users.encryptionSalt })
    .from(users)
    .where(and(eq(users.isAdmin, false), eq(users.deletionStatus, 'active')));
  return rows.map((r) => ({ id: r.id, uuid: r.uuid, encryptionSalt: r.encryptionSalt }));
}

// --- User scan state (Fix 1: incremental scanner) ---

/**
 * Application-level interface for the scan state shape. The Drizzle-inferred
 * type (from schema) adds `userId` as PK — callers use this narrower interface
 * for backwards compatibility with the legacy db.ts shape.
 */
export interface UserScanState {
  lastScannedAt: Date;
  lastSeenS3Key: string | null;
  fullRescanDueAt: Date;
}

export interface OrphanObject {
  id: number;
  s3Bucket: string;
  s3Key: string;
  sizeBytes: number;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: number | null;
}

export async function createReconciliationRun(
  usersChecked: number,
  correctionsMade: number,
  orphansFound: number,
  orphanBytesTotal: number,
  zombiesCleaned: number,
  zombiesRemaining: number,
  eventsReconciled: number,
  eventsDeleted: number,
  durationMs: number,
): Promise<number> {
  const [row] = await db
    .insert(storageReconciliationRuns)
    .values({
      usersChecked,
      correctionsMade,
      orphansFound,
      orphanBytesTotal,
      zombiesCleaned,
      zombiesRemaining,
      eventsReconciled,
      eventsDeleted,
      durationMs,
    })
    .returning({ id: storageReconciliationRuns.id });
  return row.id;
}

export async function recordDiskCorrection(
  runId: number,
  userId: number,
  email: string,
  oldBytes: number,
  newBytes: number,
): Promise<void> {
  await db.insert(storageDiskCorrections).values({
    runId,
    userId,
    email,
    oldBytes,
    newBytes,
    deltaBytes: newBytes - oldBytes,
  });
}

export async function setDiskUsageAbsolute(userId: number, bytes: number): Promise<void> {
  await db.update(users).set({ diskUsageBytes: bytes }).where(eq(users.id, userId));
}

// ==== Reconciliation: orphan tracking ====

export async function upsertOrphanObject(
  s3Bucket: string,
  s3Key: string,
  sizeBytes: number,
): Promise<void> {
  await upsertOrphanObjects([{ s3Bucket, s3Key, sizeBytes }]);
}

/**
 * Batched form of {@link upsertOrphanObject} — ONE statement per chunk instead
 * of one round trip per object.
 *
 * This is not micro-optimisation. The single-row version was awaited inside the
 * reconciler's per-object detection loop, so a run re-recorded every known
 * orphan sequentially: tens of thousands of orphans x ~8.5 ms = minutes,
 * against a fixed job deadline. The audit CronJob was killed by
 * `DeadlineExceeded`, and because storage reconciliation runs FIRST,
 * everything after it — retention, quota tidy, upload_events pruning —
 * silently stopped running.
 *
 * Chunked because Postgres caps a statement at 65535 bound parameters; at 3
 * columns per row, 500 rows/chunk keeps us far under it with room to add a
 * column later.
 *
 * `firstSeenAt` is deliberately NOT touched on conflict — it is what the 7-day
 * auto-purge grace window is measured from, so re-observing an orphan must
 * never reset its clock.
 */
export async function upsertOrphanObjects(
  rows: Array<{ s3Bucket: string; s3Key: string; sizeBytes: number }>,
): Promise<void> {
  if (rows.length === 0) return;
  // Deduplicate on the conflict target FIRST. Postgres rejects a statement
  // whose VALUES list hits the same conflict row twice ("ON CONFLICT DO UPDATE
  // command cannot affect row a second time") — that is a hard error, not a
  // skipped row, so a single duplicate would abort the whole sweep. The
  // detection loops list distinct keys per bucket today, but nothing in the
  // type system enforces that, and the failure mode is far too blunt to leave
  // to convention. Last write wins, matching the sequential version.
  const deduped = new Map<string, { s3Bucket: string; s3Key: string; sizeBytes: number }>();
  for (const r of rows) deduped.set(`${r.s3Bucket} ${r.s3Key}`, r);
  const unique = [...deduped.values()];

  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    await db
      .insert(storageOrphanObjects)
      .values(chunk)
      .onConflictDoUpdate({
        target: [storageOrphanObjects.s3Bucket, storageOrphanObjects.s3Key],
        set: {
          sizeBytes: sql`EXCLUDED.size_bytes`,
          lastSeenAt: sql`NOW()`,
          seenCount: sql`${storageOrphanObjects.seenCount} + 1`,
        },
      });
  }
}

function mapOrphanRow(r: StorageOrphanObject): OrphanObject {
  return {
    id: r.id,
    s3Bucket: r.s3Bucket,
    s3Key: r.s3Key,
    sizeBytes: Number(r.sizeBytes),
    firstSeenAt:
      r.firstSeenAt instanceof Date ? r.firstSeenAt.toISOString() : r.firstSeenAt,
    lastSeenAt:
      r.lastSeenAt instanceof Date ? r.lastSeenAt.toISOString() : r.lastSeenAt,
    seenCount: r.seenCount,
    acknowledged: r.acknowledged,
    acknowledgedAt: r.acknowledgedAt
      ? r.acknowledgedAt instanceof Date
        ? r.acknowledgedAt.toISOString()
        : r.acknowledgedAt
      : null,
    acknowledgedBy: r.acknowledgedBy ?? null,
  };
}

export async function deleteOrphanObjectRow(id: number): Promise<boolean> {
  const result = await db
    .delete(storageOrphanObjects)
    .where(eq(storageOrphanObjects.id, id))
    .returning({ id: storageOrphanObjects.id });
  return result.length > 0;
}

/**
 * Orphans whose `first_seen_at` is older than `days` ago. Used by the
 * reconciler's auto-purge sweep — anything in this list has been visible
 * in S3 long enough that no in-flight user-deletion or pending-DB-commit
 * race could explain it.
 */
export async function getOrphansOlderThan(days: number, limit = 500): Promise<OrphanObject[]> {
  const rows = await db
    .select()
    .from(storageOrphanObjects)
    .where(
      sql`${storageOrphanObjects.firstSeenAt} < NOW() - (${String(days)} || ' days')::interval`,
    )
    .orderBy(storageOrphanObjects.firstSeenAt)
    .limit(limit);
  return rows.map(mapOrphanRow);
}

// ==== Wipe helpers (used by wipe-user-content admin script) ====

/**
 * Delete all upload_events rows for a user and zero their rolling 30-day
 * counter (the wipe removes every row in the window). Returns count of deleted
 * rows.
 */
export async function deleteUploadEventsByUser(userId: number): Promise<number> {
  return withTx(async (tx) => {
    const result = await tx.delete(uploadEvents).where(eq(uploadEvents.userId, userId));
    await tx.update(users).set({ upload30dBytes: 0 }).where(eq(users.id, userId));
    return result.rowCount ?? 0;
  });
}

/** Delete the user_scan_state row (if any) for a user. Returns count of deleted rows. */
export async function deleteUserScanState(userId: number): Promise<number> {
  const result = await db.delete(userScanState).where(eq(userScanState.userId, userId));
  return result.rowCount ?? 0;
}

/** Reset all content-related quota counters for a user by internal id. */
export async function resetUserContentQuota(internalId: number): Promise<void> {
  const now = new Date();
  const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await db
    .update(users)
    .set({
      diskUsageBytes: 0,
      transferUsageBytes: 0,
      transferResetAt: nextReset,
      uploadLifetimeBytes: 0,
    })
    .where(eq(users.id, internalId));
}
