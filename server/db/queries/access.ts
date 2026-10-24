import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../index.js';
import { users } from '../schema/users.js';

// Two independent locks. access_locked_at: the account has no active plan (set
// and lifted by the edition's plan rules). admin_locked_at: an administrator
// locked it (set and lifted only by an administrator). Either one locks.
export interface AccessLockState { locked: boolean; adminLocked: boolean; planLocked: boolean }

export async function getAccessLockState(userId: number, tx?: Tx): Promise<AccessLockState> {
  const [row] = await (tx ?? db)
    .select({ planLockedAt: users.accessLockedAt, adminLockedAt: users.adminLockedAt })
    .from(users)
    .where(eq(users.id, userId));
  const planLocked = !!row?.planLockedAt;
  const adminLocked = !!row?.adminLockedAt;
  return { locked: planLocked || adminLocked, adminLocked, planLocked };
}

/** Whether the account's access is locked, by either lock. */
export async function isAccessLocked(userId: number): Promise<boolean> {
  return (await getAccessLockState(userId)).locked;
}

/**
 * Set or lift the "no active plan" lock (access_locked_at). Never touches the
 * administrator's lock. Locking an already-locked account keeps the original
 * lock time. Returns false when no such user exists.
 */
export async function setAccessLocked(userId: number, locked: boolean, tx?: Tx): Promise<boolean> {
  const result = await (tx ?? db)
    .update(users)
    .set({ accessLockedAt: locked ? sql`COALESCE(${users.accessLockedAt}, NOW())` : null })
    .where(eq(users.id, userId));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Set or lift the administrator's lock (admin_locked_at). Called only on an
 * administrator's action: the admin route that locks and unlocks an account,
 * and the edition's unlock helper it goes through. Never by plan rules.
 */
export async function setAdminLocked(userId: number, locked: boolean, tx?: Tx): Promise<boolean> {
  const result = await (tx ?? db)
    .update(users)
    .set({ adminLockedAt: locked ? sql`COALESCE(${users.adminLockedAt}, NOW())` : null })
    .where(eq(users.id, userId));
  return (result.rowCount ?? 0) > 0;
}
