import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { userSessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { CONFIG } from '../../config.js';

// Per-device sessions (see server/db/schema/sessions.ts). The session id is the
// `sid` claim of the tokens issued for it.

function nextExpiry(): Date {
  return new Date(Date.now() + CONFIG.refreshTokenExpirySeconds * 1000);
}

/** Open a session for a sign-in and return its id. */
export async function createSession(userId: number): Promise<string> {
  const id = randomBytes(16).toString('base64url');
  await db.insert(userSessions).values({ id, userId, expiresAt: nextExpiry() });
  return id;
}

/**
 * Extend a session on refresh. Returns false when it no longer stands —
 * revoked, expired, deleted, or belonging to another user — and the refresh
 * must be refused.
 */
export async function touchSession(id: string, userId: number): Promise<boolean> {
  const rows = await db.update(userSessions)
    .set({ lastUsedAt: sql`now()`, expiresAt: nextExpiry() })
    .where(and(
      eq(userSessions.id, id),
      eq(userSessions.userId, userId),
      isNull(userSessions.revokedAt),
      gt(userSessions.expiresAt, sql`now()`),
    ))
    .returning({ id: userSessions.id });
  return rows.length > 0;
}

/** End one session (sign-out on one device). Returns whether it was still live. */
export async function revokeSession(id: string, userId: number): Promise<boolean> {
  const rows = await db.update(userSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  return rows.length > 0;
}

/**
 * What requireAuth needs for a token that carries a session: the account's
 * token generation and whether the session still stands, in one round trip.
 * `tokenGeneration` is -1 when the user does not exist (never matches a token).
 */
export async function getSessionAuthState(
  userId: number,
  sessionId: string,
): Promise<{ tokenGeneration: number; sessionActive: boolean }> {
  const [row] = await db
    .select({ tokenGeneration: users.tokenGeneration, sessionId: userSessions.id })
    .from(users)
    .leftJoin(userSessions, and(
      eq(userSessions.id, sessionId),
      eq(userSessions.userId, users.id),
      isNull(userSessions.revokedAt),
    ))
    .where(eq(users.id, userId));
  if (!row) return { tokenGeneration: -1, sessionActive: false };
  return { tokenGeneration: row.tokenGeneration, sessionActive: row.sessionId !== null };
}

/** Delete sessions whose refresh token has expired (revoked or not). */
export async function deleteExpiredSessions(): Promise<number> {
  const rows = await db.delete(userSessions)
    .where(lt(userSessions.expiresAt, new Date()))
    .returning({ id: userSessions.id });
  return rows.length;
}
