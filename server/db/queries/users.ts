// server/db/queries/users.ts
import { eq, and, isNull, sql, type SQL } from 'drizzle-orm';
import { db, withTx } from '../index.js';
import { users, plans, passkeyBackupCodes } from '../schema/index.js';
import type { User } from '../../types.js';
import { clearLoginLockouts } from './lockout.js';

/**
 * Canonical Drizzle query patterns — used across queries/*.ts.
 *
 * 1. Simple SELECT returning row | null:
 *    const [row] = await db.select().from(t).where(eq(t.col, v));
 *    return row ?? null;
 *
 * 2. SELECT many:
 *    return await db.select().from(t).where(...).orderBy(...).limit(...);
 *
 * 3. SELECT subset of columns (explicit return type):
 *    return await db.select({ id: t.id, name: t.name }).from(t).where(...);
 *
 * 4. INSERT one with RETURNING *:
 *    const [row] = await db.insert(t).values(input).returning();
 *
 * 5. INSERT many:
 *    await db.insert(t).values(rows);
 *
 * 6. UPDATE with WHERE:
 *    await db.update(t).set({ col: val }).where(eq(t.id, id));
 *
 * 7. UPDATE with RETURNING subset:
 *    const [row] = await db.update(t).set({...}).where(...)
 *      .returning({ sizeBytes: t.sizeBytes });
 *
 * 8. DELETE returning:
 *    const [row] = await db.delete(t).where(...)
 *      .returning({ id: t.id });
 *    return row ?? null;
 *
 * 9. UPSERT (ON CONFLICT):
 *    await db.insert(t).values(rows)
 *      .onConflictDoUpdate({ target: t.id, set: { col: sql`EXCLUDED.col` } });
 *
 * 10. JOIN:
 *    const rows = await db.select({ ... })
 *      .from(events).leftJoin(fileMetadata, eq(events.wideVideo, fileMetadata.id))
 *      .where(...).groupBy(events.camera);
 *
 * 11. Transaction:
 *    await withTx(async (tx) => {
 *      await tx.insert(...).values(...);
 *      await tx.update(...).set(...).where(...);
 *    });
 *
 * 12. Advisory lock (per-user):
 *    await withUserLock(LOCK_NS_EVENTS, internalUserId, async (tx) => {
 *      // ... queries on tx ...
 *    });
 *
 * 13. RAW sql tag (LATERAL, window funcs, CTEs with MATERIALIZED, advisory lock SQL):
 *    const rows = await db.execute(sql<{ id: string, count: number }>`
 *      SELECT id, COUNT(*) OVER () as count FROM events WHERE owner_id = ${userId}
 *    `);
 *    // Access rows via result.rows; type the row shape via sql<RowShape>.
 */

// Pattern 10: JOIN users + plans, with camelCase mapping to application-level User type
export async function getUserByUuid(
  uuid: string,
): Promise<(User & { internalId: number; passwordHash: string | null; tokenGeneration: number }) | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      uuid: users.uuid,
      email: users.email,
      emailVerified: users.emailVerified,
      passwordHash: users.passwordHash,
      isAdmin: users.isAdmin,
      active: users.active,
      createdAt: users.createdAt,
      tokenGeneration: users.tokenGeneration,
      planId: users.planId,
      encryptionSalt: users.encryptionSalt,
      diskUsageBytes: users.diskUsageBytes,
      transferUsageBytes: users.transferUsageBytes,
      deletionStatus: users.deletionStatus,
      planSource: users.planSource,
      planExpiresAt: users.planExpiresAt,
      planName: plans.name,
    })
    .from(users)
    .leftJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.uuid, uuid));

  if (!row) return undefined;

  return {
    internalId: row.id,
    id: row.uuid,
    email: row.email,
    emailVerified: row.emailVerified,
    passwordHash: row.passwordHash,
    isAdmin: row.isAdmin,
    active: row.active,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    tokenGeneration: row.tokenGeneration,
    planId: row.planId ?? undefined,
    planName: row.planName ?? undefined,
    encryptionSalt: row.encryptionSalt ?? undefined,
    diskUsageBytes: Number(row.diskUsageBytes),
    transferUsageBytes: Number(row.transferUsageBytes),
    deletionStatus: (row.deletionStatus ?? 'active') as User['deletionStatus'],
    planSource: row.planSource as User['planSource'],
    planExpiresAt: row.planExpiresAt instanceof Date ? row.planExpiresAt.toISOString() : null,
  };
}

export async function getUserCount(): Promise<number> {
  const [row] = await db.select({ cnt: sql<number>`COUNT(*)::int` }).from(users);
  return row?.cnt ?? 0;
}

// Pattern 10: JOIN users + plans, filter by email + deletion_status='active'
export async function getUserByEmail(
  email: string,
): Promise<(User & { internalId: number; passwordHash: string | null; tokenGeneration: number }) | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      uuid: users.uuid,
      email: users.email,
      emailVerified: users.emailVerified,
      passwordHash: users.passwordHash,
      isAdmin: users.isAdmin,
      active: users.active,
      createdAt: users.createdAt,
      tokenGeneration: users.tokenGeneration,
      planId: users.planId,
      encryptionSalt: users.encryptionSalt,
      diskUsageBytes: users.diskUsageBytes,
      transferUsageBytes: users.transferUsageBytes,
      deletionStatus: users.deletionStatus,
      planSource: users.planSource,
      planExpiresAt: users.planExpiresAt,
      planName: plans.name,
    })
    .from(users)
    .leftJoin(plans, eq(users.planId, plans.id))
    .where(and(eq(users.email, email), eq(users.deletionStatus, 'active')));

  if (!row) return undefined;

  return {
    internalId: row.id,
    id: row.uuid,
    email: row.email,
    emailVerified: row.emailVerified,
    passwordHash: row.passwordHash,
    isAdmin: row.isAdmin,
    active: row.active,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    tokenGeneration: row.tokenGeneration,
    planId: row.planId ?? undefined,
    planName: row.planName ?? undefined,
    encryptionSalt: row.encryptionSalt ?? undefined,
    diskUsageBytes: Number(row.diskUsageBytes),
    transferUsageBytes: Number(row.transferUsageBytes),
    deletionStatus: (row.deletionStatus ?? 'active') as User['deletionStatus'],
    planSource: row.planSource as User['planSource'],
    planExpiresAt: row.planExpiresAt instanceof Date ? row.planExpiresAt.toISOString() : null,
  };
}

// Lightweight UUID→internalId lookup (no join needed)
export async function getUserInternalIdByUuid(uuid: string): Promise<number | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.uuid, uuid));
  return row?.id ?? null;
}

// Pattern 10: JOIN users + plans, filter by internal id
export async function getUserByInternalId(
  id: number,
): Promise<(User & { internalId: number; passwordHash: string | null; tokenGeneration: number }) | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      uuid: users.uuid,
      email: users.email,
      emailVerified: users.emailVerified,
      passwordHash: users.passwordHash,
      isAdmin: users.isAdmin,
      active: users.active,
      createdAt: users.createdAt,
      tokenGeneration: users.tokenGeneration,
      planId: users.planId,
      encryptionSalt: users.encryptionSalt,
      diskUsageBytes: users.diskUsageBytes,
      transferUsageBytes: users.transferUsageBytes,
      deletionStatus: users.deletionStatus,
      planSource: users.planSource,
      planExpiresAt: users.planExpiresAt,
      planName: plans.name,
    })
    .from(users)
    .leftJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.id, id));

  if (!row) return undefined;

  return {
    internalId: row.id,
    id: row.uuid,
    email: row.email,
    emailVerified: row.emailVerified,
    passwordHash: row.passwordHash,
    isAdmin: row.isAdmin,
    active: row.active,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    tokenGeneration: row.tokenGeneration,
    planId: row.planId ?? undefined,
    planName: row.planName ?? undefined,
    encryptionSalt: row.encryptionSalt ?? undefined,
    diskUsageBytes: Number(row.diskUsageBytes),
    transferUsageBytes: Number(row.transferUsageBytes),
    deletionStatus: (row.deletionStatus ?? 'active') as User['deletionStatus'],
    planSource: row.planSource as User['planSource'],
    planExpiresAt: row.planExpiresAt instanceof Date ? row.planExpiresAt.toISOString() : null,
  };
}

/**
 * Normalize a timestamp column read via db.execute(sql`...`) to ISO-8601.
 *
 * Raw SQL bypasses Drizzle's column mapping, so node-postgres hands these
 * columns back as raw Postgres text ("2026-05-26 18:43:56.591823+00" — space
 * separator, microseconds, bare "+00"), NOT a Date. The lenient
 * `instanceof Date ? .toISOString() : v` guard (see isoOrNull) is INSUFFICIENT
 * here: its string branch leaks that raw shape straight to res.json, which a
 * strict client (the native iOS .iso8601 decoder) rejects. Re-parse and
 * re-emit as ISO-8601 (Z) so this endpoint matches every other one. Handles a
 * real Date too, in case a future driver or query path returns one.
 */
function rowTsToIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/**
 * getAllUsers: LATERAL subquery for active ban count — stays on raw sql tag.
 * Drizzle has no LATERAL join support; this query cannot be expressed in the
 * builder without raw SQL anyway.
 *
 * `planLockStands` (written against the alias `u`) is the edition's rule for
 * "the plan rules lock this account". An account the administrator locked may
 * still carry a copy of that lock in access_locked_at; it is reported as
 * plan-locked only when the rule says the plan lock really stands, so the list
 * does not show two locks where there is one. Default: no such rule, so an
 * administrator's lock is never also reported as a plan lock.
 */
export async function getAllUsers(opts: { planLockStands?: SQL } = {}): Promise<User[]> {
  const planLockStands = opts.planLockStands ?? sql`FALSE`;
  const result = await db.execute<{
    uuid: string;
    email: string;
    email_verified: boolean;
    is_admin: boolean;
    active: boolean;
    // db.execute returns timestamptz as raw Postgres text, never a Date — see rowTsToIso.
    created_at: string;
    plan_id: number | null;
    disk_usage_bytes: string | number;
    transfer_usage_bytes: string | number;
    deletion_status: string | null;
    plan_name: string | null;
    ban_expires_at: string | null;
    ban_reason: string | null;
    active_bans: number;
    access_locked: boolean;
    admin_locked: boolean;
    plan_locked: boolean;
    plan_override_at: Date | string | null;
    plan_source: string;
    plan_expires_at: Date | string | null;
  }>(sql`
    SELECT u.uuid, u.email, u.email_verified, u.is_admin, u.active, u.created_at, u.plan_id,
           u.disk_usage_bytes, u.transfer_usage_bytes,
           u.deletion_status, u.plan_source, u.plan_expires_at,
           (u.access_locked_at IS NOT NULL OR u.admin_locked_at IS NOT NULL) AS access_locked,
           (u.admin_locked_at IS NOT NULL) AS admin_locked,
           (u.access_locked_at IS NOT NULL AND (u.admin_locked_at IS NULL OR ${planLockStands})) AS plan_locked,
           u.plan_override_at,
           p.name as plan_name,
           b.expires_at AS ban_expires_at, b.reason AS ban_reason,
           COALESCE(cnt.active_bans, 0) AS active_bans
    FROM users u
    LEFT JOIN plans p ON u.plan_id = p.id
    LEFT JOIN LATERAL (
      SELECT expires_at, reason
        FROM user_bans
        WHERE user_id = u.id AND type = 'manual'
          AND cancelled_at IS NULL AND expires_at > NOW()
        ORDER BY expires_at DESC LIMIT 1
    ) b ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS active_bans
        FROM user_bans
        WHERE user_id = u.id
          AND cancelled_at IS NULL AND expires_at > NOW()
    ) cnt ON TRUE
    ORDER BY u.created_at ASC
  `);
  return result.rows.map(r => ({
    id: r.uuid,
    email: r.email,
    emailVerified: r.email_verified,
    isAdmin: r.is_admin,
    active: r.active,
    // created_at is NOT NULL (defaultNow), so rowTsToIso never returns null here.
    createdAt: rowTsToIso(r.created_at)!,
    planId: r.plan_id ?? undefined,
    planName: r.plan_name ?? undefined,
    diskUsageBytes: Number(r.disk_usage_bytes),
    transferUsageBytes: Number(r.transfer_usage_bytes),
    bannedUntil: rowTsToIso(r.ban_expires_at),
    bannedReason: r.ban_reason ?? null,
    activeBanCount: Number(r.active_bans ?? 0),
    deletionStatus: (r.deletion_status ?? 'active') as User['deletionStatus'],
    accessLocked: r.access_locked === true,
    adminLocked: r.admin_locked === true,
    planLocked: r.plan_locked === true,
    planOverrideAt: rowTsToIso(r.plan_override_at),
    planSource: r.plan_source as User['planSource'],
    planExpiresAt: rowTsToIso(r.plan_expires_at),
  }));
}

/**
 * Physical row delete — relies on ON DELETE CASCADE for events/files/notifications.
 */
export async function hardDeleteUser(uuid: string): Promise<boolean> {
  const result = await db.delete(users).where(eq(users.uuid, uuid));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Set a new password. Signs every session out (token generation) and lifts
 * the account's login lockouts on both channels — they were earned against
 * the old password; `includeIpLocks` also lifts the IP-wide FTP lockouts
 * attached to the account (see clearLoginLockouts). One transaction: either
 * all of it happens or none, so a password never changes without the sign-out.
 */
export async function updateUserPasswordByInternalId(
  id: number,
  passwordHash: string,
  opts: { includeIpLocks?: boolean } = {},
): Promise<boolean> {
  return withTx(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ passwordHash, tokenGeneration: sql`${users.tokenGeneration} + 1` })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (updated.length === 0) return false;
    await clearLoginLockouts(id, opts, tx);
    return true;
  });
}

export async function resetUserQuota(
  uuid: string,
  opts: { storage?: boolean; transfer?: boolean } = { storage: true, transfer: true },
): Promise<boolean> {
  const setValues: Record<string, unknown> = {};
  if (opts.storage) setValues.diskUsageBytes = 0;
  if (opts.transfer) {
    const now = new Date();
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    setValues.transferUsageBytes = 0;
    setValues.transferResetAt = nextReset;
  }
  if (Object.keys(setValues).length === 0) return false;
  const result = await db.update(users).set(setValues).where(eq(users.uuid, uuid));
  return (result.rowCount ?? 0) > 0;
}

export async function getTokenGeneration(id: number): Promise<number> {
  const [row] = await db.select({ tokenGeneration: users.tokenGeneration }).from(users).where(eq(users.id, id));
  return row?.tokenGeneration ?? -1;
}

/**
 * Bump the global token_generation for a user, revoking every outstanding
 * access + refresh token in one shot. Backs POST /auth/logout (sign-out
 * everywhere), consistent with password-change / passkey-removal. Returns
 * false when no such user row exists.
 */
export async function bumpTokenGeneration(internalId: number): Promise<boolean> {
  const result = await db.update(users)
    .set({ tokenGeneration: sql`${users.tokenGeneration} + 1` })
    .where(eq(users.id, internalId));
  return (result.rowCount ?? 0) > 0;
}

export async function incrementTokenGeneration(id: number): Promise<void> {
  await db
    .update(users)
    .set({ tokenGeneration: sql`${users.tokenGeneration} + 1` })
    .where(eq(users.id, id));
}

// ==== Passkeys ====

export interface Passkey {
  id: number;
  userId: number;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[] | null;
  deviceName: string | null;
  aaguid: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface FtpsState {
  passkeyEnabled: boolean;
  hasFtpsPassword: boolean;
  ftpsPasswordHash: string | null;
}

export function isoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

export async function countUnusedBackupCodes(userId: number): Promise<number> {
  const [row] = await db
    .select({ cnt: sql<number>`COUNT(*)::int` })
    .from(passkeyBackupCodes)
    .where(and(eq(passkeyBackupCodes.userId, userId), isNull(passkeyBackupCodes.usedAt)));
  return row?.cnt ?? 0;
}

export async function getFtpsState(userId: number): Promise<FtpsState | undefined> {
  const [row] = await db
    .select({ passkeyEnabled: users.passkeyEnabled, ftpsPasswordHash: users.ftpsPasswordHash })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return undefined;
  return {
    passkeyEnabled: !!row.passkeyEnabled,
    hasFtpsPassword: row.ftpsPasswordHash != null,
    ftpsPasswordHash: row.ftpsPasswordHash,
  };
}

// Advisory lock key that serialises bootstrap attempts (services/bootstrap.ts).
const SETUP_ADVISORY_LOCK_KEY = 7311074n;

/**
 * Atomically create the very first account on an empty database.
 *
 * Acquires SETUP_ADVISORY_LOCK_KEY, checks the users table is still empty and
 * inserts the account with the role the edition asked for: Clipnest Cloud
 * bootstraps an operator (admin) on the Basic plan; a self-hosted install
 * bootstraps its single owner with no plan (⇒ unlimited storage/transfer).
 * Returns `true` on success, `false` when another user already exists
 * (idempotency guard).
 *
 * Raises on any other DB error — the caller is responsible for exiting.
 */
export async function createFirstAccount(opts: {
  uuid: string;
  email: string;
  passwordHash: string;
  encryptionSalt: string;
  isAdmin: boolean;
  /** Plan to attach by name, or null for no plan (unlimited). */
  planName: string | null;
}): Promise<boolean> {
  const { withTx } = await import('../index.js');
  return withTx(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_ADVISORY_LOCK_KEY}::bigint)`);
    const countResult = await tx.execute<{ cnt: string }>(
      sql`SELECT COUNT(*) AS cnt FROM users`,
    );
    if (parseInt((countResult.rows[0] as { cnt: string }).cnt, 10) > 0) {
      return false;
    }
    let planId: number | null = null;
    if (opts.planName) {
      const [plan] = await tx
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.name, opts.planName));
      planId = plan?.id ?? null;
    }
    await tx.insert(users).values({
      uuid: opts.uuid,
      email: opts.email,
      emailVerified: true,
      passwordHash: opts.passwordHash,
      isAdmin: opts.isAdmin,
      planId,
      encryptionSalt: opts.encryptionSalt,
      active: true,
    });
    return true;
  });
}

export async function getAllUserUuids(): Promise<Set<string>> {
  const rows = await db
    .select({ uuid: users.uuid })
    .from(users)
    .where(and(eq(users.isAdmin, false), eq(users.deletionStatus, 'active')));
  return new Set(rows.map((r) => r.uuid));
}

/**
 * Every user's UUID, regardless of admin flag or deletion status.
 *
 * Unlike `getAllUserUuids` (active, non-admin only) this includes admins and
 * users in any deletion state (e.g. `pending`/`scheduled`). The storage
 * reconciler uses it as the PURGE GUARD so that an object under an admin
 * prefix, or under a user stuck mid-deletion for longer than the orphan grace
 * window, is never classified as truly-unowned and auto-deleted — a data-loss
 * path. Keep `getAllUserUuids` for orphan DETECTION/upsert; use this for the
 * delete guard.
 */
export async function getAllUserUuidsAnyStatus(): Promise<string[]> {
  const rows = await db
    .select({ uuid: users.uuid })
    .from(users);
  return rows.map((r) => r.uuid);
}
