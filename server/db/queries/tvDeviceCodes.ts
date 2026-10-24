import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../index.js';
import { tvDeviceCodes, type TvDeviceCode } from '../schema/tv.js';

export async function createDeviceCode(input: {
  userCode: string;
  deviceCode: string;
  expiresAt: Date;
  deviceId?: string | null;
}): Promise<void> {
  await db.insert(tvDeviceCodes).values({
    userCode: input.userCode,
    deviceCode: input.deviceCode,
    expiresAt: input.expiresAt,
    deviceId: input.deviceId ?? null,
  });
}

/**
 * Invalidate every still-pending code previously issued to `deviceId`. Called
 * when the TV requests a fresh code (e.g. after a restart): the old user_code
 * shown on a now-dead screen must stop being approvable. We flip the rows to
 * 'denied' — /approve only matches status='pending', and /token treats 'denied'
 * as dead — so a superseded code is rejected end-to-end. Returns the count
 * invalidated. No-op for an empty deviceId (older clients that don't send one).
 */
export async function invalidatePendingDeviceCodesForDevice(deviceId: string): Promise<number> {
  if (!deviceId) return 0;
  const rows = await db
    .update(tvDeviceCodes)
    .set({ status: 'denied' })
    .where(and(eq(tvDeviceCodes.deviceId, deviceId), eq(tvDeviceCodes.status, 'pending')))
    .returning({ id: tvDeviceCodes.id });
  return rows.length;
}

export async function getDeviceCodeByDeviceCode(deviceCode: string): Promise<TvDeviceCode | undefined> {
  const [row] = await db
    .select()
    .from(tvDeviceCodes)
    .where(eq(tvDeviceCodes.deviceCode, deviceCode));
  return row;
}

/**
 * Atomically approve a still-pending, unexpired code for `userId`. The WHERE
 * guard (status='pending' AND expires_at > now()) makes approval a single SQL
 * round-trip with no read-modify-write race: a lapsed or already-approved code
 * matches zero rows and returns undefined.
 */
export async function approveDeviceCode(userCode: string, userId: number): Promise<TvDeviceCode | undefined> {
  const [row] = await db
    .update(tvDeviceCodes)
    .set({ status: 'approved', userId, approvedAt: new Date() })
    .where(
      and(
        eq(tvDeviceCodes.userCode, userCode),
        eq(tvDeviceCodes.status, 'pending'),
        sql`${tvDeviceCodes.expiresAt} > now()`,
      ),
    )
    .returning();
  return row;
}

/**
 * Kill every code approved for (or bound to) `userId` that has not been
 * exchanged yet: /token treats 'denied' as dead, so no TV can still pick up a
 * session from it. Used when an account's sign-in methods are reset. Pass `tx`
 * to make it part of a caller's transaction. Returns the count.
 */
export async function denyOpenDeviceCodesForUser(userId: number, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db)
    .update(tvDeviceCodes)
    .set({ status: 'denied' })
    .where(and(eq(tvDeviceCodes.userId, userId), inArray(tvDeviceCodes.status, ['pending', 'approved'])))
    .returning({ id: tvDeviceCodes.id });
  return rows.length;
}

/** Burn a code after it has been exchanged for tokens (single-use). */
export async function markDeviceCodeUsed(id: number): Promise<void> {
  await db.update(tvDeviceCodes).set({ status: 'used' }).where(eq(tvDeviceCodes.id, id));
}

/** Sweep lapsed codes. Returns the number of rows removed. */
export async function deleteExpiredDeviceCodes(): Promise<number> {
  const rows = await db
    .delete(tvDeviceCodes)
    .where(lt(tvDeviceCodes.expiresAt, new Date()))
    .returning({ id: tvDeviceCodes.id });
  return rows.length;
}
