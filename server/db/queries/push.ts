// server/db/queries/push.ts
//
// Query helpers for the push-notification device registry + per-user delivery
// preferences. Mirrors the style of db/queries/notifications.ts (single-purpose async
// functions, Date→ISO normalisation in the map layer).
import { eq, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { pushDevices, pushPrefs } from '../schema/index.js';

// ============================================================
// Devices
// ============================================================

/**
 * Register (or refresh) a device token for a user. Upsert keyed on the UNIQUE
 * `device_token`: if the same physical device re-registers — possibly under a
 * different account — the row is re-pointed at the new `user_id` and its
 * `platform` / `environment` / `last_seen_at` are refreshed. This guarantees a
 * given token only ever fans out to its current owner.
 */
export async function upsertPushDevice(args: {
  userId: number;
  deviceToken: string;
  platform: string;
  environment?: string;
  supportsLocKeys?: boolean;
}): Promise<void> {
  const environment = args.environment ?? 'production';
  const supportsLocKeys = args.supportsLocKeys ?? false;
  await db
    .insert(pushDevices)
    .values({
      userId: args.userId,
      deviceToken: args.deviceToken,
      platform: args.platform,
      environment,
      supportsLocKeys,
    })
    .onConflictDoUpdate({
      target: pushDevices.deviceToken,
      set: {
        userId: args.userId,
        platform: args.platform,
        environment,
        supportsLocKeys,
        lastSeenAt: new Date(),
      },
    });
}

/**
 * Remove a device token. Scoped to the owning user so one account can't
 * unregister another's token by guessing it. Returns true when a row was
 * deleted.
 */
export async function deletePushDevice(userId: number, deviceToken: string): Promise<boolean> {
  const result = await db
    .delete(pushDevices)
    .where(sql`${pushDevices.userId} = ${userId} AND ${pushDevices.deviceToken} = ${deviceToken}`)
    .returning({ id: pushDevices.id });
  return result.length > 0;
}

/**
 * Prune a token by its value alone (no user scope) — used by the push worker
 * when APNs returns 410 Unregistered / BadDeviceToken for it. Idempotent.
 */
export async function prunePushDeviceByToken(deviceToken: string): Promise<void> {
  await db.delete(pushDevices).where(eq(pushDevices.deviceToken, deviceToken));
}

export interface PushDeviceRow {
  deviceToken: string;
  platform: string;
  environment: string;
  supportsLocKeys: boolean;
  /** Set for relay-delivered devices (see schema/push.ts). */
  relay?: { deviceId: string; publicKey: string };
}

/** `device_token` placeholder of a relay-delivered device. */
export const relayTokenPlaceholder = (relayDeviceId: string): string => `relay:${relayDeviceId}`;

/**
 * Register a relay-delivered device: the server stores the device's public
 * key and the id the relay knows it by — never a push token. Re-registering
 * the same relay device id re-points it at the current user.
 */
export async function upsertRelayPushDevice(args: {
  userId: number;
  relayDeviceId: string;
  publicKey: string;
  platform: string;
}): Promise<void> {
  const deviceToken = relayTokenPlaceholder(args.relayDeviceId);
  await db
    .insert(pushDevices)
    .values({
      userId: args.userId,
      deviceToken,
      platform: args.platform,
      // Relay-delivered payloads are decrypted and localized on the device.
      supportsLocKeys: true,
      relayDeviceId: args.relayDeviceId,
      publicKey: args.publicKey,
    })
    .onConflictDoUpdate({
      target: pushDevices.deviceToken,
      set: { userId: args.userId, platform: args.platform, publicKey: args.publicKey, lastSeenAt: new Date() },
    });
}

/** Every live device token for a user. Empty array when none registered. */
export async function getPushDevicesForUser(userId: number): Promise<PushDeviceRow[]> {
  const rows = await db
    .select({
      deviceToken: pushDevices.deviceToken,
      platform: pushDevices.platform,
      environment: pushDevices.environment,
      supportsLocKeys: pushDevices.supportsLocKeys,
      relayDeviceId: pushDevices.relayDeviceId,
      publicKey: pushDevices.publicKey,
    })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId));
  return rows.map(({ relayDeviceId, publicKey, ...row }) => ({
    ...row,
    ...(relayDeviceId && publicKey ? { relay: { deviceId: relayDeviceId, publicKey } } : {}),
  }));
}

// ============================================================
// Preferences
// ============================================================

export interface PushPrefsRow {
  /** ISO timestamp the do-not-disturb window lasts until, or null. */
  snoozeUntil: string | null;
  /** notification-kind → enabled. Absent kind = enabled (opt-out model). */
  categories: Record<string, boolean>;
}

function mapPrefs(row: {
  snoozeUntil: Date | null;
  categories: Record<string, boolean> | null;
}): PushPrefsRow {
  return {
    snoozeUntil: row.snoozeUntil
      ? row.snoozeUntil instanceof Date
        ? row.snoozeUntil.toISOString()
        : String(row.snoozeUntil)
      : null,
    categories: row.categories ?? {},
  };
}

/**
 * Read a user's push preferences. Returns the opt-everything-in default
 * (`{ snoozeUntil: null, categories: {} }`) when the user has no row yet —
 * push is on by default; the user explicitly opts out via PUT /push-prefs.
 */
export async function getPushPrefs(userId: number): Promise<PushPrefsRow> {
  const [row] = await db
    .select({ snoozeUntil: pushPrefs.snoozeUntil, categories: pushPrefs.categories })
    .from(pushPrefs)
    .where(eq(pushPrefs.userId, userId));
  if (!row) return { snoozeUntil: null, categories: {} };
  return mapPrefs(row);
}

/**
 * Upsert a user's push preferences. Only the provided fields are written:
 *   - `snoozeUntil: undefined` leaves the existing window untouched;
 *   - `snoozeUntil: null` clears it;
 *   - `snoozeUntil: <ISO>` sets it.
 *   - `categories: undefined` leaves the existing map; an object REPLACES it.
 * Returns the resulting row so the route can echo it back.
 */
export async function upsertPushPrefs(
  userId: number,
  patch: { snoozeUntil?: string | null; categories?: Record<string, boolean> },
): Promise<PushPrefsRow> {
  const snoozeDate =
    patch.snoozeUntil === undefined
      ? undefined
      : patch.snoozeUntil === null
        ? null
        : new Date(patch.snoozeUntil);

  // Build the insert + the conflict-update set independently so an absent
  // field is left untouched on update (vs. an explicit null which clears).
  const insertValues = {
    userId,
    snoozeUntil: snoozeDate ?? null,
    categories: patch.categories ?? {},
  };
  const updateSet: Partial<{ snoozeUntil: Date | null; categories: Record<string, boolean> }> = {};
  if (snoozeDate !== undefined) updateSet.snoozeUntil = snoozeDate;
  if (patch.categories !== undefined) updateSet.categories = patch.categories;

  // If nothing to update (both absent) the upsert still ensures a row exists.
  const [row] = await db
    .insert(pushPrefs)
    .values(insertValues)
    .onConflictDoUpdate({
      target: pushPrefs.userId,
      set: Object.keys(updateSet).length > 0 ? updateSet : { userId },
    })
    .returning({ snoozeUntil: pushPrefs.snoozeUntil, categories: pushPrefs.categories });

  return mapPrefs(row);
}
