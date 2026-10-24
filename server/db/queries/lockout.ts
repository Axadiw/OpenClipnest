// server/db/queries/lockout.ts
//
// Failed-login lockouts: the per-account tier (5 failures in a row on one
// login channel) and the per-IP credential-spray tier (FTP only), both
// persisted as `type = 'lockout'` rows in `user_bans`, plus the generic
// ban-row listing/cancel helpers those rows are managed through.
// `isUserBanned` reads manual bans too: the login paths are shared, and a
// self-hosted install simply never writes one. The writers (ban/unban,
// appeals) are cloud-only: server/cloud/db/queries/moderation.ts.
//
// Two login channels are counted and locked independently:
//   - 'web': HTTP sign-in (password, passkey, backup code, OAuth);
//   - 'ftp': camera FTP/FTPS logins (POST /internal/auth/verify).
// A camera that keeps retrying a stale password therefore never locks the
// owner out of the web, and failed web sign-ins never stop the cameras.
// Manual bans apply to both. A lockout row without a channel predates the
// split and blocks both until it expires.
import { eq, and, or, isNull, gt, sql, desc, inArray } from 'drizzle-orm';
import { db, withTx, type Tx } from '../index.js';
import { userBans, users, ipLoginAttempts } from '../schema/index.js';
import type { BanStatus } from '../../types.js';

// Patterns reference: server/db/queries/users.ts (top of file)

/** Sentinel expiry for indefinite bans — lets queries compare timestamps without branching. */
export const INDEFINITE_BAN_ISO = '9999-01-01T00:00:00.000Z';

/** Which login a failed attempt — and the lockout it may trip — belongs to. */
export type LoginChannel = 'web' | 'ftp';

/** Consecutive failures on one channel that lock that channel. */
export const LOCKOUT_THRESHOLD = 5;
/** The first lockout on a channel; every further one in a row doubles. */
const LOCKOUT_BASE_SECONDS = 60;
// The lockouts of one channel in a row — a streak, which a success on that
// channel or a password change ends — double from one minute but are held at
// the channel's cap for the first LOCKOUT_CAPPED_TIERS of them: 60 min on the
// web, 15 min on FTP, so a camera retrying an outdated password is back soon
// after its owner fixes it. A streak that goes on past that is guessing, not a
// stale camera: from there the lockouts double again from the cap, up to
// LOCKOUT_CEILING_SECONDS, so it cannot continue at a steady rate forever.
export const LOCKOUT_CAP_SECONDS: Readonly<Record<LoginChannel, number>> = { web: 60 * 60, ftp: 15 * 60 };
export const LOCKOUT_CAPPED_TIERS = 8;
export const LOCKOUT_CEILING_SECONDS = 24 * 60 * 60;

/**
 * Length of the `tier`-th lockout in a row on `channel`. Web: 1, 2, 4, 8, 16,
 * 32, 60, 60, then 120, 240, 480, 960, 1440 … minutes. FTP: 1, 2, 4, 8, 15,
 * 15, 15, 15, then 30, 60, 120, 240, 480, 960, 1440 … minutes.
 */
export function lockoutSeconds(channel: LoginChannel, tier: number): number {
  const cap = LOCKOUT_CAP_SECONDS[channel];
  const t = Math.max(1, tier);
  if (t <= LOCKOUT_CAPPED_TIERS) return Math.min(LOCKOUT_BASE_SECONDS * 2 ** (t - 1), cap);
  return Math.min(cap * 2 ** (t - LOCKOUT_CAPPED_TIERS), LOCKOUT_CEILING_SECONDS);
}

// The users-row counters of each channel: consecutive failures and the
// lockout tier (how many lockouts in a row, which sets the next duration).
const COUNTERS = {
  web: {
    attempts: users.failedLoginAttempts,
    tier: users.lockoutCount,
    bump: { failedLoginAttempts: sql`${users.failedLoginAttempts} + 1` },
    trip: (tier: number) => ({ failedLoginAttempts: 0, lockoutCount: tier }),
    reset: { failedLoginAttempts: 0, lockoutCount: 0 },
  },
  ftp: {
    attempts: users.ftpFailedLoginAttempts,
    tier: users.ftpLockoutCount,
    bump: { ftpFailedLoginAttempts: sql`${users.ftpFailedLoginAttempts} + 1` },
    trip: (tier: number) => ({ ftpFailedLoginAttempts: 0, ftpLockoutCount: tier }),
    reset: { ftpFailedLoginAttempts: 0, ftpLockoutCount: 0 },
  },
} as const;

// ── Per-IP credential-spray throttle ────────────────────────────────────────
// The per-user lockout fires at 5 failures on a SINGLE account; it can't catch
// one IP spraying passwords across many usernames. These
// govern the per-IP lockout that does.
//
// Threshold/window tuning: a legitimate camera site sits behind ONE premises IP
// and its cameras normally auth with the correct password, so failures are rare
// (a password rotation lag, a mistyped credential). 20 failed FTPS auths against
// valid accounts within 15 minutes from a single IP is far above the "handful of
// failures" a shared-NAT site produces after a rotation, yet well below the
// hundreds/thousands a spray tool generates — so it stops spray without locking
// out a real multi-camera site. If a badly misconfigured large site does trip it,
// the lockout auto-expires and an admin can cancel it immediately from the ban
// list. Only failures against REAL accounts advance the counter (attempts on
// non-existent usernames can never succeed, so they're not the threat here and
// give the counter no attach-point).
const IP_FAILED_THRESHOLD = 20;
const IP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const IP_LOCKOUT_BASE_SECONDS = 15 * 60; // first lockout: 15 min, then doubling
const IP_LOCKOUT_MAX_SECONDS = 24 * 60 * 60; // cap escalation at 24 h

/**
 * Is this account locked out of `channel`? Counts the account's own lockouts
 * on that channel plus the channel-less ones that predate the split. An
 * IP-scoped spray lockout is not an account lockout — it blocks its address,
 * for every username, through {@link isIpLocked} — so it never counts here.
 */
export async function isUserLocked(
  internalId: number,
  channel: LoginChannel,
): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const [row] = await db
    .select({ expiresAt: userBans.expiresAt })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, internalId),
        eq(userBans.type, 'lockout'),
        isNull(userBans.sourceIp),
        or(eq(userBans.channel, channel), isNull(userBans.channel)),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.expiresAt))
    .limit(1);

  if (!row) return { locked: false, lockedUntil: null };
  const lockedUntil =
    row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);
  return { locked: true, lockedUntil };
}

/**
 * Count a failed login on `channel`. The {@link LOCKOUT_THRESHOLD}th failure
 * in a row locks that channel of the account for {@link lockoutSeconds} of the
 * streak's next tier and starts the count again. The other channel is not
 * touched.
 */
export async function recordFailedLogin(internalId: number, channel: LoginChannel): Promise<void> {
  const counters = COUNTERS[channel];
  await withTx(async (tx) => {
    // The row lock this UPDATE takes serialises concurrent failures on the
    // same account, so exactly one of them can trip the lockout.
    const [row] = await tx
      .update(users)
      .set(counters.bump)
      .where(eq(users.id, internalId))
      .returning({ attempts: counters.attempts, tier: counters.tier });
    if (!row || row.attempts < LOCKOUT_THRESHOLD) return;

    // Start counting again and raise the tier so the next lockout is longer;
    // the lockout itself is a row in user_bans.
    const tier = row.tier + 1;
    await tx.update(users).set(counters.trip(tier)).where(eq(users.id, internalId));
    await tx.insert(userBans).values({
      userId: internalId,
      type: 'lockout',
      channel,
      reason: null,
      // Counted from the database clock, like created_at (NOW() = the start
      // of this transaction): a JS Date.now() taken after waiting for the row
      // lock above would make the lockout longer than its tier.
      expiresAt: sql`NOW() + make_interval(secs => ${lockoutSeconds(channel, tier)})`,
    });
  });
}

/** A successful login on `channel`: clear that channel's counters only. */
export async function resetLoginAttempts(internalId: number, channel: LoginChannel): Promise<void> {
  // Any lockout row of the channel has expired or been cancelled — the login
  // could not have got here otherwise — so only the counters need resetting.
  await db
    .update(users)
    .set(COUNTERS[channel].reset)
    .where(eq(users.id, internalId));
}

/**
 * The account's password changed: forget the failed attempts and lockout tiers
 * on both channels and lift its active lockouts, which were earned against the
 * old password. Manual bans stay (a moderation decision). IP-scoped spray
 * lockouts block an address rather than the account, so they are lifted —
 * together with their address's failure counter and tier — only with
 * `includeIpLocks`, which only the operator's own action passes (the
 * self-hosted password sync): where anyone can hold an account, lifting them
 * on every password change would let a sprayer unblock its address by
 * changing its own password. Runs in the caller's transaction when given one.
 */
export async function clearLoginLockouts(
  internalId: number,
  opts: { includeIpLocks?: boolean } = {},
  tx?: Tx,
): Promise<void> {
  if (!tx) return withTx((t) => clearLoginLockouts(internalId, opts, t));
  // users → user_bans → ip_login_attempts: the order every writer in this
  // module takes its row locks in, so concurrent ones cannot deadlock.
  await tx
    .update(users)
    .set({ ...COUNTERS.web.reset, ...COUNTERS.ftp.reset })
    .where(eq(users.id, internalId));
  const lifted = await tx
    .update(userBans)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(userBans.userId, internalId),
        eq(userBans.type, 'lockout'),
        opts.includeIpLocks ? undefined : isNull(userBans.sourceIp),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .returning({ sourceIp: sql<string | null>`host(${userBans.sourceIp})` });
  await forgetIpAttempts(tx, lifted);
}

/**
 * Drop the spray counters (failures and tier) of the addresses whose lockouts
 * were just lifted, so a lifted IP lockout does not come back at a higher tier.
 */
async function forgetIpAttempts(tx: Tx, lifted: ReadonlyArray<{ sourceIp: string | null }>): Promise<void> {
  const ips = [...new Set(lifted.map((r) => r.sourceIp).filter((ip): ip is string => ip !== null))];
  if (ips.length > 0) await tx.delete(ipLoginAttempts).where(inArray(ipLoginAttempts.sourceIp, ips));
}

/**
 * Is this source IP currently blocked by a credential-spray lockout?
 *
 * Queries user_bans for an active IP-scoped lockout (source_ip match, not
 * cancelled, not expired). Cancelling the ban row via the admin DELETE route
 * (which sets cancelled_at) immediately unblocks the IP — this filter is what
 * makes the lockout admin-cancellable through the existing ban machinery.
 */
export async function isIpLocked(
  sourceIp: string,
): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const [row] = await db
    .select({ expiresAt: userBans.expiresAt })
    .from(userBans)
    .where(
      and(
        eq(userBans.sourceIp, sourceIp),
        eq(userBans.type, 'lockout'),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.expiresAt))
    .limit(1);

  if (!row) return { locked: false, lockedUntil: null };
  const lockedUntil =
    row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);
  return { locked: true, lockedUntil };
}

/**
 * Record a failed FTPS auth against a real account from `sourceIp` and, once the
 * per-IP failure count crosses the threshold within the rolling window, write an
 * IP-scoped `lockout` ban that blocks every subsequent FTPS auth from that IP
 * (across all usernames) via {@link isIpLocked}.
 *
 * `tripUserId` is the internal id of the account this failed attempt targeted;
 * the lockout row is attached to it so the ban surfaces in that user's
 * `GET /users/:uuid/bans` list and is cancellable via the existing DELETE route,
 * while `source_ip` is what actually scopes the block to the whole IP. It is an
 * FTP lockout: it never blocks the web sign-in, nor this account's FTP logins
 * from other addresses.
 *
 * Complements — never replaces — the per-account {@link recordFailedLogin} on
 * the 'ftp' channel: a single account seeing 5 failures still trips its own
 * (shorter) lockout first.
 */
export async function recordFailedLoginByIp(sourceIp: string, tripUserId: number): Promise<void> {
  await withTx(async (tx) => {
    const now = new Date();
    const [existing] = await tx
      .select({
        failedAttempts: ipLoginAttempts.failedAttempts,
        windowStartedAt: ipLoginAttempts.windowStartedAt,
        lockoutCount: ipLoginAttempts.lockoutCount,
      })
      .from(ipLoginAttempts)
      .where(eq(ipLoginAttempts.sourceIp, sourceIp));

    // Start a fresh window if there's no row yet or the current window elapsed.
    const windowStart =
      existing?.windowStartedAt instanceof Date
        ? existing.windowStartedAt
        : existing
          ? new Date(String(existing.windowStartedAt))
          : null;
    const windowExpired = !windowStart || now.getTime() - windowStart.getTime() >= IP_WINDOW_MS;

    const attempts = existing && !windowExpired ? existing.failedAttempts + 1 : 1;
    const lockoutCount = existing ? existing.lockoutCount : 0;

    if (attempts >= IP_FAILED_THRESHOLD) {
      // Threshold tripped: escalate the tier, reset the counter + window, and
      // write the IP-scoped lockout ban.
      const newLockoutCount = lockoutCount + 1;
      const lockoutSeconds = Math.min(
        IP_LOCKOUT_BASE_SECONDS * Math.pow(2, newLockoutCount - 1),
        IP_LOCKOUT_MAX_SECONDS,
      );
      const expiresAt = new Date(now.getTime() + lockoutSeconds * 1000);

      await tx
        .insert(ipLoginAttempts)
        .values({ sourceIp, failedAttempts: 0, windowStartedAt: now, lockoutCount: newLockoutCount })
        .onConflictDoUpdate({
          target: ipLoginAttempts.sourceIp,
          set: { failedAttempts: 0, windowStartedAt: now, lockoutCount: newLockoutCount },
        });

      await tx.insert(userBans).values({
        userId: tripUserId,
        type: 'lockout',
        channel: 'ftp',
        reason: null,
        sourceIp,
        expiresAt,
      });
      return;
    }

    // Below threshold: just bump (or start) the windowed counter.
    await tx
      .insert(ipLoginAttempts)
      .values({ sourceIp, failedAttempts: attempts, windowStartedAt: windowExpired ? now : (windowStart ?? now), lockoutCount })
      .onConflictDoUpdate({
        target: ipLoginAttempts.sourceIp,
        set: { failedAttempts: attempts, windowStartedAt: windowExpired ? now : (windowStart ?? now) },
      });
  });
}

export interface UserBanRow {
  id: number;
  type: 'manual' | 'lockout';
  reason: string | null;
  issuedBy: number | null;
  createdAt: string;
  expiresAt: string;
  indefinite: boolean;
  // Populated only for credential-spray IP lockouts; NULL for manual bans and
  // per-user lockouts. Normalised with host() so admins see a bare address
  // (e.g. 203.0.113.5) — a raw inet SELECT would serialize the /32 host mask.
  sourceIp: string | null;
  // The login a lockout blocks ('web' or 'ftp'); NULL for manual bans and for
  // lockouts that predate the split (those block both).
  channel: LoginChannel | null;
}

/** List active bans for a user (admin UI). */
export async function listActiveBans(internalId: number): Promise<UserBanRow[]> {
  const rows = await db
    .select({
      id: userBans.id,
      type: userBans.type,
      reason: userBans.reason,
      issuedBy: userBans.issuedBy,
      createdAt: userBans.createdAt,
      expiresAt: userBans.expiresAt,
      // host() strips the /32 (IPv4) or /128 (IPv6) host mask that a plain
      // inet→text serialization would append; NULL passes through as NULL.
      sourceIp: sql<string | null>`host(${userBans.sourceIp})`,
      channel: userBans.channel,
    })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, internalId),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.createdAt));

  return rows.map((r) => {
    const expires =
      r.expiresAt instanceof Date ? r.expiresAt.toISOString() : String(r.expiresAt);
    return {
      id: r.id,
      type: r.type as 'manual' | 'lockout',
      reason: r.reason ?? null,
      issuedBy: r.issuedBy ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      expiresAt: expires,
      indefinite: expires >= INDEFINITE_BAN_ISO,
      sourceIp: r.sourceIp ?? null,
      channel: r.channel ?? null,
    };
  });
}

/**
 * Cancel a single ban by id. Returns false when the ban doesn't belong to the
 * given user (prevents an admin from cancelling bans across users via a crafted
 * path) or is already cancelled/expired.
 */
export async function cancelBan(banId: number, internalId: number): Promise<boolean> {
  const result = await db
    .update(userBans)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(userBans.id, banId),
        eq(userBans.userId, internalId),
        isNull(userBans.cancelledAt),
      ),
    )
    .returning({ id: userBans.id });

  return result.length > 0;
}

/**
 * Cancel ALL active bans of a user — manual bans, account lockouts on either
 * channel and the IP-scoped spray lockouts attached to the account — and reset
 * both channels' failed-login counters and lockout tiers, and the spray
 * counters of the addresses it unblocks, so the next failure starts from
 * scratch instead of re-locking at once or at a longer tier. Used by the
 * `reset-user-ban` operator script (unlike `unbanUser`, which only clears
 * manual bans via the admin UI).
 * Returns the number of bans cancelled.
 */
export async function cancelAllActiveBansForUser(internalId: number): Promise<number> {
  return withTx(async (tx) => {
    // Same lock order as clearLoginLockouts: users → user_bans → ip_login_attempts.
    await tx
      .update(users)
      .set({ ...COUNTERS.web.reset, ...COUNTERS.ftp.reset })
      .where(eq(users.id, internalId));

    const result = await tx
      .update(userBans)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(userBans.userId, internalId),
          isNull(userBans.cancelledAt),
          gt(userBans.expiresAt, new Date()),
        ),
      )
      .returning({ sourceIp: sql<string | null>`host(${userBans.sourceIp})` });
    await forgetIpAttempts(tx, result);

    return result.length;
  });
}

/** Active manual (moderation) ban for a user, if any. Never true on a self-hosted install. */
export async function isUserBanned(internalId: number): Promise<BanStatus> {
  const [row] = await db
    .select({ expiresAt: userBans.expiresAt, reason: userBans.reason })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, internalId),
        eq(userBans.type, 'manual'),
        isNull(userBans.cancelledAt),
        gt(userBans.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userBans.expiresAt))
    .limit(1);

  if (!row) return { banned: false };
  const iso =
    row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt);
  const indefinite = iso >= INDEFINITE_BAN_ISO;
  return {
    banned: true,
    until: iso,
    reason: row.reason ?? undefined,
    indefinite,
  };
}
