// server/db/queries/notifications.ts
import { eq, and, isNull, isNotNull, lt, sql, desc } from 'drizzle-orm';
import { db, withTx } from '../index.js';
import { notifications } from '../schema/index.js';
import type { NotificationKind } from '../../types.js';

// Patterns reference: server/db/queries/users.ts (top of file)

function mapNotification(row: {
  id: number;
  userId: number;
  kind: string;
  message: string;
  details: Record<string, unknown> | null | undefined;
  readAt: Date | null | undefined;
  createdAt: Date;
}): import('../../types.js').Notification {
  return {
    id: String(row.id),
    userId: row.userId,
    kind: row.kind as NotificationKind,
    message: row.message,
    details: row.details ?? null,
    readAt: row.readAt
      ? row.readAt instanceof Date
        ? row.readAt.toISOString()
        : String(row.readAt)
      : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

/**
 * Short, human-readable push title per notification kind. The in-app feed
 * already renders kind→icon/label, but a push banner needs a standalone title
 * line above the `message` body. Falls back to the product name.
 */
function pushTitleForKind(kind: NotificationKind): string {
  switch (kind) {
    case 'new_recording':
      return 'New recording';
    case 'storage_quota_exceeded':
      return 'Storage full';
    case 'transfer_quota_exceeded':
      return 'Transfer limit reached';
    case 'auto_deleted_oldest':
      return 'Old recordings removed';
    case 'invalid_file':
      return 'Upload problem';
    case 'thumbnail_failed':
      return 'Recording problem';
    case 'duplicate_file':
      return 'Duplicate recording';
    case 'user_banned':
      return 'Account notice';
    case 'plan_change_cancelled':
      return 'Plan change cancelled';
    case 'content_deletion_scheduled':
      return 'Recordings will be deleted';
    case 'content_deleted':
      return 'Recordings deleted';
    default:
      return 'Clipnest';
  }
}

export async function createNotification(
  userId: number,
  kind: NotificationKind,
  message: string,
  details?: Record<string, unknown>,
): Promise<import('../../types.js').Notification> {
  const [row] = await db
    .insert(notifications)
    .values({ userId, kind, message, details: details ?? null })
    .returning();

  // Fan out to the push-worker group. Fire-and-forget: a Redis hiccup (or no
  // push worker running at all, e.g. in compose/dev) must never fail or delay
  // the notification write. The push worker applies snooze/category filters
  // and resolves devices, so we publish for EVERY notification regardless of
  // the user's prefs — the consumer is the policy point. Lazy import avoids a
  // static cycle (streamsClient → redis; this module is imported very early).
  const fanOut = import('../../services/streamsClient.js')
    .then(({ publishPush }) =>
      publishPush({
        userId: String(userId),
        notificationId: String(row.id),
        kind,
        title: pushTitleForKind(kind),
        message,
        details: JSON.stringify(details ?? {}),
      }),
    )
    .catch((err) =>
      console.error(
        'createNotification: push fan-out failed:',
        err instanceof Error ? err.message : String(err),
      ),
    );
  pendingFanOuts.add(fanOut);
  void fanOut.finally(() => pendingFanOuts.delete(fanOut));

  return mapNotification(row);
}

// Fan-outs still in flight. A long-running process never needs this; a
// one-shot job (a CronJob that closes Redis and exits) awaits them first so
// the pushes it created are not dropped at exit.
const pendingFanOuts = new Set<Promise<unknown>>();

/** Wait (at most `timeoutMs`) for the push fan-outs of notifications created so far. Never throws. */
export async function flushNotificationPushes(timeoutMs = 5000): Promise<void> {
  if (pendingFanOuts.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...pendingFanOuts]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

export async function listNotifications(
  userId: number,
  opts: { limit?: number; before?: string } = {},
): Promise<import('../../types.js').Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const conditions = [eq(notifications.userId, userId)];
  if (opts.before) {
    conditions.push(lt(notifications.id, Number(opts.before)));
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.id))
    .limit(limit);

  return rows.map(mapNotification);
}

export async function markNotificationRead(userId: number, id: string): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, Number(id)),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });

  return result.length > 0;
}

export async function markAllNotificationsRead(userId: number): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return result.length;
}

export async function getUnreadNotificationCount(userId: number): Promise<number> {
  const result = await db.execute(sql<{ cnt: string }>`
    SELECT COUNT(*)::int AS cnt
    FROM notifications
    WHERE user_id = ${userId} AND read_at IS NULL
  `);
  return Number((result.rows[0] as { cnt: string })?.cnt ?? 0);
}

/**
 * True if a notification of `kind` was created for this user within the last
 * `withinMs`. Dedups self-healing warnings (e.g. `storage_quota_exceeded`) that
 * now fire from multiple triggers — the inline upload path, the admin
 * plan-change handler, and the 1-min reconciler backstop — so a user who sits
 * over the threshold gets at most one in-app notification per window instead of
 * one per trigger per tick. Mirrors the 7-day cooldown the storage-warning
 * email already enforces via `storage_warn_email_sent_at`; reads off
 * `created_at` so no extra column/migration is needed.
 */
export async function hasRecentNotification(
  userId: number,
  kind: NotificationKind,
  withinMs: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinMs);
  const result = await db.execute(sql<{ one: number }>`
    SELECT 1 AS one
    FROM notifications
    WHERE user_id = ${userId} AND kind = ${kind} AND created_at >= ${cutoff}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

export async function deleteNotification(userId: number, id: string): Promise<boolean> {
  const result = await db
    .delete(notifications)
    .where(and(eq(notifications.id, Number(id)), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });

  return result.length > 0;
}

export async function deleteReadNotifications(userId: number): Promise<number> {
  const result = await db
    .delete(notifications)
    .where(and(eq(notifications.userId, userId), isNotNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return result.length;
}

/** Delete ALL notifications for a user (used by wipe-user-content admin script). */
export async function deleteAllNotificationsForUser(userId: number): Promise<number> {
  const result = await db
    .delete(notifications)
    .where(eq(notifications.userId, userId));
  return result.rowCount ?? 0;
}

export type DuplicateFileNotificationInput = {
  eventId: string;
  camera: string;
  timestamp: string;
  /** Profile-defined view id (e.g. '00', '01', 'A'). The notification UI
   *  resolves the human-readable label via the profile registry. */
  viewId: string;
  visiblePath: string;
  hiddenPath: string;
};

function formatDuplicateFileMessage(
  camera: string,
  timestamp: string,
  visiblePath: string,
  hiddenPaths: string[],
): string {
  const quoted = (s: string) => `"${s}"`;
  const hiddenList = hiddenPaths.map(quoted).join(', ');
  return (
    `Duplicate recording for camera "${camera}" at ${timestamp}. ` +
    `Visible in the library: "${visiblePath}". ` +
    `Hidden duplicates (same camera + timestamp, different folder): ${hiddenList}. ` +
    `You can remove the duplicate files via your FTP client to free up storage.`
  );
}

/**
 * Idempotent upsert for the 'duplicate_file' notification: at most one row
 * per (user, eventId), with extra duplicate paths appended to
 * `details.hiddenPaths` instead of spawning new notifications.
 *
 *  - No row → INSERT with `hiddenPaths: [hiddenPath]`.
 *  - Row exists, `hiddenPath` already listed → no-op.
 *  - Row exists, new `hiddenPath` → UPDATE: append, refresh message, clear
 *    `read_at` so the user re-notices.
 *
 * Wrapped in a transaction with SELECT … FOR UPDATE to keep concurrent
 * scanner workers from each inserting their own row for the same event.
 */
export async function upsertDuplicateFileNotification(
  userId: number,
  dup: DuplicateFileNotificationInput,
): Promise<{ created: boolean; updated: boolean; skipped: boolean }> {
  return withTx(async (tx) => {
    // Lock any existing row for this (user, eventId) before deciding
    const existing = await tx.execute(sql<{
      id: number;
      details: Record<string, unknown> | null;
    }>`
      SELECT id, details
      FROM notifications
      WHERE user_id = ${userId}
        AND kind = 'duplicate_file'
        AND details->>'eventId' = ${dup.eventId}
      LIMIT 1
      FOR UPDATE
    `);

    if (existing.rows.length === 0) {
      const details = {
        eventId: dup.eventId,
        camera: dup.camera,
        timestamp: dup.timestamp,
        viewId: dup.viewId,
        visiblePath: dup.visiblePath,
        hiddenPaths: [dup.hiddenPath],
        locKey: 'notif.duplicate_file.body',
        locArgs: [dup.camera],
      };
      const message = formatDuplicateFileMessage(
        dup.camera,
        dup.timestamp,
        dup.visiblePath,
        [dup.hiddenPath],
      );
      await tx.insert(notifications).values({
        userId,
        kind: 'duplicate_file',
        message,
        details,
      });
      return { created: true, updated: false, skipped: false };
    }

    const row = existing.rows[0] as { id: number; details: { hiddenPaths?: unknown[] } | null };
    const detailsObj = row.details;
    const hiddenPaths: string[] = Array.isArray(detailsObj?.hiddenPaths)
      ? (detailsObj!.hiddenPaths as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];

    if (hiddenPaths.includes(dup.hiddenPath)) {
      return { created: false, updated: false, skipped: true };
    }

    const nextHiddenPaths = [...hiddenPaths, dup.hiddenPath];
    const message = formatDuplicateFileMessage(
      dup.camera,
      dup.timestamp,
      dup.visiblePath,
      nextHiddenPaths,
    );

    await tx.execute(sql`
      UPDATE notifications
        SET details = jsonb_set(details, '{hiddenPaths}', ${JSON.stringify(nextHiddenPaths)}::jsonb),
            message = ${message},
            read_at = NULL
      WHERE id = ${row.id}
    `);

    return { created: false, updated: true, skipped: false };
  });
}

/**
 * Drop notifications tied to a given event id (via `details ->> 'eventId'`).
 * Called when the storage reconciler deletes the event — keeping its
 * thumbnail_failed / invalid_file breadcrumbs around just lets the user
 * click an "Otwórz nagranie" link that 404s.
 */
export async function deleteNotificationsForEvent(eventId: string): Promise<number> {
  const result = await db.execute(sql<{ count: string }>`
    DELETE FROM notifications WHERE details ->> 'eventId' = ${eventId}
  `);
  return result.rowCount ?? 0;
}
