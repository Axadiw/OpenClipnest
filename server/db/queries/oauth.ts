// server/db/queries/oauth.ts
import { eq, and, sql, isNull, gt } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db, withTx } from '../index.js';
import {
  oauthClients,
  oauthAuthorizationTxns,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  mcpAuditLog,
} from '../schema/index.js';

// Patterns reference: server/db/queries/users.ts (top of file)

// ==== OAuth Clients ====

export interface CreateClientInput {
  clientName: string;
  redirectUris: string[];
  softwareId?: string;
  softwareVersion?: string;
  /** Null for anonymous Dynamic Client Registration (RFC 7591 §3.1).
   *  Populated when the registration comes via the Settings → MCP Clients
   *  broker, which authenticates the user first. */
  createdByUserId: number | null;
}

/** Insert a new oauth_client and return its generated client_id (UUID). */
export async function createClient(i: CreateClientInput): Promise<string> {
  const clientId = randomUUID();
  await db.insert(oauthClients).values({
    clientId,
    clientName: i.clientName,
    redirectUris: i.redirectUris,
    softwareId: i.softwareId ?? null,
    softwareVersion: i.softwareVersion ?? null,
    createdByUserId: i.createdByUserId ?? null,
  });
  return clientId;
}

export interface OauthClientRow {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  revokedAt: Date | null;
  createdByUserId: number | null;
}

/** Fetch a single oauth_client by client_id. Returns null if not found. */
export async function getClient(clientId: string): Promise<OauthClientRow | null> {
  const [row] = await db
    .select({
      clientId: oauthClients.clientId,
      clientName: oauthClients.clientName,
      redirectUris: oauthClients.redirectUris,
      revokedAt: oauthClients.revokedAt,
      createdByUserId: oauthClients.createdByUserId,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}

/**
 * Revoke an oauth_client and cascade-revoke all tokens belonging to it.
 * Leaves oauth_clients row in place (just marks revoked_at).
 */
export async function revokeClient(clientId: string): Promise<void> {
  await db
    .update(oauthClients)
    .set({ revokedAt: sql`NOW()` })
    .where(eq(oauthClients.clientId, clientId));
  // Cascade-revoke all tokens belonging to this client.
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthAccessTokens.clientId, clientId),
        isNull(oauthAccessTokens.revokedAt),
      ),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    );
}

// ==== Authorization Transactions (60-second pre-consent state) ====

export interface InsertTxnInput {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  resource: string;
}

/** Insert a new PKCE authorization transaction. Returns the generated txn_id (UUID). */
export async function insertTxn(i: InsertTxnInput): Promise<string> {
  const txnId = randomUUID();
  await db.insert(oauthAuthorizationTxns).values({
    txnId,
    clientId: i.clientId,
    redirectUri: i.redirectUri,
    scope: i.scope,
    state: i.state,
    codeChallenge: i.codeChallenge,
    codeChallengeMethod: 'S256',
    resource: i.resource,
  });
  return txnId;
}

/** Fetch an unconsumed authorization transaction. Returns null if missing or already consumed. */
export async function getTxnById(txnId: string): Promise<typeof oauthAuthorizationTxns.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(oauthAuthorizationTxns)
    .where(
      and(
        eq(oauthAuthorizationTxns.txnId, txnId),
        isNull(oauthAuthorizationTxns.consumedAt),
      ),
    );
  return row ?? null;
}

/**
 * Atomically claim a txn: sets user_id + consumed_at.
 * Returns null if missing/consumed/expired (> 10 minutes).
 */
export async function claimTxn(
  txnId: string,
  userId: number,
  grantedScopes: string,
): Promise<typeof oauthAuthorizationTxns.$inferSelect | null> {
  const [row] = await db
    .update(oauthAuthorizationTxns)
    .set({ userId, scope: grantedScopes, consumedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthAuthorizationTxns.txnId, txnId),
        isNull(oauthAuthorizationTxns.consumedAt),
        sql`${oauthAuthorizationTxns.createdAt} > NOW() - interval '10 minutes'`,
      ),
    )
    .returning();
  return row ?? null;
}

// ==== Authorization Codes (single-use, 60 s) ====

export interface InsertAuthCodeInput {
  codeHash: Buffer;
  clientId: string;
  userId: number;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string;
  expiresAt: Date;
  familyId: string;
}

/** Insert a new authorization code (SHA-256 hash stored, not raw code). */
export async function insertAuthCode(i: InsertAuthCodeInput): Promise<void> {
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: i.codeHash,
    clientId: i.clientId,
    userId: i.userId,
    redirectUri: i.redirectUri,
    scope: i.scope,
    codeChallenge: i.codeChallenge,
    resource: i.resource,
    expiresAt: i.expiresAt,
    familyId: i.familyId,
  });
}

/** Atomically mark a code consumed. Returns the row or null on second call or expiry. */
export async function claimAuthCodeAtomic(
  codeHash: Buffer,
): Promise<typeof oauthAuthorizationCodes.$inferSelect | null> {
  const [row] = await db
    .update(oauthAuthorizationCodes)
    .set({ consumedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        isNull(oauthAuthorizationCodes.consumedAt),
        sql`${oauthAuthorizationCodes.expiresAt} > NOW()`,
      ),
    )
    .returning();
  return row ?? null;
}

// ==== Access Tokens ====

export interface InsertAccessTokenInput {
  tokenHash: Buffer;
  clientId: string;
  userId: number;
  scope: string;
  familyId: string;
  expiresAt: Date;
  /** users.token_generation captured at grant issuance. Defaults to 0. */
  tokenGeneration?: number;
}

/** Insert a new OAuth access token (SHA-256 hash stored, not raw token). */
export async function insertAccessToken(i: InsertAccessTokenInput): Promise<void> {
  await db.insert(oauthAccessTokens).values({
    tokenHash: i.tokenHash,
    clientId: i.clientId,
    userId: i.userId,
    scope: i.scope,
    familyId: i.familyId,
    expiresAt: i.expiresAt,
    tokenGeneration: i.tokenGeneration ?? 0,
  });
}

/**
 * Fetch an access token row and update last_used_at as a side-effect.
 * Returns null when the hash is not found.
 * Does NOT check expires_at or revoked_at — caller's responsibility.
 */
export async function getAccessTokenByHash(
  tokenHash: Buffer,
): Promise<typeof oauthAccessTokens.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.tokenHash, tokenHash));
  if (!row) return null;
  // Side-effect: track last use time.
  await db
    .update(oauthAccessTokens)
    .set({ lastUsedAt: sql`NOW()` })
    .where(eq(oauthAccessTokens.tokenHash, tokenHash));
  return row;
}

/** Revoke a single access token by hash. Idempotent. */
export async function revokeAccessToken(tokenHash: Buffer): Promise<void> {
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt),
      ),
    );
}

// ==== Refresh Tokens (rotation + family revoke) ====

export interface InsertRefreshTokenInput {
  tokenHash: Buffer;
  clientId: string;
  userId: number;
  scope: string;
  familyId: string;
  expiresAt: Date;
  /** users.token_generation captured at grant issuance. Defaults to 0. */
  tokenGeneration?: number;
}

/** Insert a new OAuth refresh token (SHA-256 hash stored, not raw token). */
export async function insertRefreshToken(i: InsertRefreshTokenInput): Promise<void> {
  await db.insert(oauthRefreshTokens).values({
    tokenHash: i.tokenHash,
    clientId: i.clientId,
    userId: i.userId,
    scope: i.scope,
    familyId: i.familyId,
    expiresAt: i.expiresAt,
    tokenGeneration: i.tokenGeneration ?? 0,
  });
}

/**
 * Rotate a refresh token atomically under a row-level FOR UPDATE lock.
 *
 * Returns:
 *  'rotated'  — successful rotation; old token is now revoked with rotated_to set.
 *  'reused'   — token was already rotated or revoked (theft detection); caller
 *               must call revokeRefreshFamily.
 *  'unknown'  — token hash not found.
 */
export async function rotateRefreshAtomic(
  oldHash: Buffer,
  newHash: Buffer,
): Promise<'rotated' | 'reused' | 'unknown'> {
  return withTx(async (tx) => {
    const result = await tx.execute(sql<{
      rotated_to: Buffer | null;
      revoked_at: Date | null;
      family_id: string;
    }>`
      SELECT rotated_to, revoked_at, family_id
        FROM oauth_refresh_tokens
       WHERE token_hash = ${oldHash}
       FOR UPDATE
    `);

    if (result.rows.length === 0) {
      return 'unknown';
    }

    const row = result.rows[0];
    if (row.rotated_to !== null || row.revoked_at !== null) {
      return 'reused';
    }

    await tx.execute(sql`
      UPDATE oauth_refresh_tokens
         SET rotated_to = ${newHash}, revoked_at = NOW()
       WHERE token_hash = ${oldHash}
    `);

    return 'rotated';
  });
}

/** Revoke all refresh tokens AND access tokens in a family (theft response). */
export async function revokeRefreshFamily(familyId: string): Promise<void> {
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthRefreshTokens.familyId, familyId),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    );
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthAccessTokens.familyId, familyId),
        isNull(oauthAccessTokens.revokedAt),
      ),
    );
}

/**
 * True if the MCP OAuth refresh-token family is still live (not revoked, not
 * expired). The API's requireAuth uses this to reject MCP-issued media tokens
 * the instant the grant is revoked — `revokeRefreshFamily` / `revokeClient`
 * set revoked_at across the family. Indexed by idx_oauth_refresh_tokens_family.
 */
export async function isMcpFamilyActive(familyId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.familyId, familyId),
        isNull(oauthRefreshTokens.revokedAt),
        gt(oauthRefreshTokens.expiresAt, sql`NOW()`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ==== Consent UI helpers ====

export interface ConsentTxnRow {
  scope: string;
  redirectUri: string;
  clientName: string;
}

/**
 * Fetch an unconsumed, non-expired authorization transaction together with
 * the client name needed by the consent UI.
 * Returns null if missing, consumed, or older than 10 minutes.
 */
export async function getConsentTxn(txnId: string): Promise<ConsentTxnRow | null> {
  const [row] = await db
    .select({
      scope: oauthAuthorizationTxns.scope,
      redirectUri: oauthAuthorizationTxns.redirectUri,
      clientName: oauthClients.clientName,
    })
    .from(oauthAuthorizationTxns)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthAuthorizationTxns.clientId))
    .where(
      and(
        eq(oauthAuthorizationTxns.txnId, txnId),
        isNull(oauthAuthorizationTxns.consumedAt),
        sql`${oauthAuthorizationTxns.createdAt} > NOW() - interval '10 minutes'`,
      ),
    );
  return row ?? null;
}

// ==== MCP Client management (Settings → MCP Clients) ====

export interface ManagedClientRow {
  clientId: string;
  clientName: string;
  /** ISO-8601 UTC, e.g. "2026-05-26T18:43:56.591Z". */
  createdAt: string;
  /** ISO-8601 UTC, or null while the user still has live access. */
  revokedAt: string | null;
  /** ISO-8601 UTC, or null if the user has never used this client. */
  lastUsedAt: string | null;
}

/**
 * Normalize a timestamp column read via db.execute(sql`...`) to ISO-8601.
 *
 * Raw SQL bypasses Drizzle's column mapping, so node-postgres hands these
 * columns back as raw Postgres text ("2026-05-26 18:43:56.591823+00" — space
 * separator, microseconds, bare "+00"), NOT a Date. Re-parse and re-emit as
 * ISO-8601 (Z) so this endpoint matches every other one and strict clients
 * (the native iOS .iso8601 decoder) accept it. Handles a real Date too, in
 * case a future driver or query path returns one.
 */
function rowTsToIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/**
 * List all OAuth clients a user has ever been issued tokens for.
 * `revokedAt` is NULL when the user has at least one active access or refresh
 * token for that client; otherwise NOW() (indicating the user's access is
 * effectively revoked).
 * `lastUsedAt` is the MAX last_used_at across the user's access tokens.
 */
export async function listManagedClients(userId: number): Promise<ManagedClientRow[]> {
  // This query joins sub-selects — use db.execute for clarity and to preserve
  // the exact semantics (CASE / double-EXISTS / UNION in sub-select).
  const result = await db.execute(sql<{
    client_id: string;
    client_name: string;
    created_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
  }>`
    SELECT c.client_id, c.client_name, c.created_at,
           (SELECT MAX(last_used_at) FROM oauth_access_tokens
             WHERE client_id = c.client_id AND user_id = ${userId}) AS last_used_at,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM oauth_access_tokens
                WHERE client_id = c.client_id AND user_id = ${userId} AND revoked_at IS NULL AND expires_at > NOW()
             ) OR EXISTS (
               SELECT 1 FROM oauth_refresh_tokens
                WHERE client_id = c.client_id AND user_id = ${userId} AND revoked_at IS NULL AND expires_at > NOW()
             ) THEN NULL
             ELSE NOW()
           END AS revoked_at
      FROM oauth_clients c
     WHERE c.client_id IN (
       SELECT client_id FROM oauth_access_tokens WHERE user_id = ${userId}
       UNION
       SELECT client_id FROM oauth_refresh_tokens WHERE user_id = ${userId}
     )
     ORDER BY c.created_at DESC
  `);
  return (result.rows as any[]).map((x) => ({
    clientId: x.client_id as string,
    clientName: x.client_name as string,
    // created_at is NOT NULL (defaultNow), so rowTsToIso never returns null here.
    createdAt: rowTsToIso(x.created_at)!,
    revokedAt: rowTsToIso(x.revoked_at),
    lastUsedAt: rowTsToIso(x.last_used_at),
  }));
}

/**
 * Check whether the given user has ever been issued any token (access or
 * refresh) for the given client. Used as the auth-ownership guard before
 * revoking.
 */
export async function userHasAnyTokenForClient(
  clientId: string,
  userId: number,
): Promise<boolean> {
  const result = await db.execute(sql<{ found: boolean }>`
    SELECT 1 AS found
      FROM oauth_access_tokens
     WHERE client_id = ${clientId} AND user_id = ${userId}
    UNION
    SELECT 1
      FROM oauth_refresh_tokens
     WHERE client_id = ${clientId} AND user_id = ${userId}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Revoke the current user's active tokens for a specific client.
 * Leaves the oauth_clients row and other users' tokens intact.
 * Idempotent — safe to call even if tokens are already revoked.
 */
export async function revokeUserTokensForClient(
  clientId: string,
  userId: number,
): Promise<void> {
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthAccessTokens.clientId, clientId),
        eq(oauthAccessTokens.userId, userId),
        isNull(oauthAccessTokens.revokedAt),
      ),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: sql`NOW()` })
    .where(
      and(
        eq(oauthRefreshTokens.clientId, clientId),
        eq(oauthRefreshTokens.userId, userId),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    );
}

// ==== TTL sweep (called by oauthSweep script) ====

/**
 * Delete all expired / stale OAuth rows per their configured TTLs.
 * Returns per-table deleted counts.
 */
export async function sweepExpiredOauthRows(): Promise<{
  txns: number; codes: number; access: number; refresh: number; audit: number;
}> {
  const txnsResult = await db
    .delete(oauthAuthorizationTxns)
    .where(sql`${oauthAuthorizationTxns.createdAt} < NOW() - interval '15 minutes'`);
  const codesResult = await db
    .delete(oauthAuthorizationCodes)
    .where(sql`${oauthAuthorizationCodes.expiresAt} < NOW() - interval '5 minutes'`);
  const accessResult = await db
    .delete(oauthAccessTokens)
    .where(sql`${oauthAccessTokens.expiresAt} < NOW() - interval '1 hour'`);
  const refreshResult = await db
    .delete(oauthRefreshTokens)
    .where(sql`${oauthRefreshTokens.expiresAt} < NOW() - interval '1 hour'`);
  const auditResult = await db
    .delete(mcpAuditLog)
    .where(sql`${mcpAuditLog.ts} < NOW() - interval '90 days'`);
  return {
    txns: txnsResult.rowCount ?? 0,
    codes: codesResult.rowCount ?? 0,
    access: accessResult.rowCount ?? 0,
    refresh: refreshResult.rowCount ?? 0,
    audit: auditResult.rowCount ?? 0,
  };
}

// ==== Bulk revoke (called by oauthRevokeAll script) ====

export interface RevokeAllOpts {
  userId?: number;
  clientId?: string;
  dryRun?: boolean;
}

/**
 * Revoke (or count, in dryRun mode) all active tokens and clients matching
 * the given filter. With no filter: affects every token and every client for
 * all users — only used in incident response scenarios.
 *
 * Uses db.execute(sql`...`) with inline conditionals because the WHERE clause
 * is dynamic (0..2 optional filter columns across two different column names).
 */
export async function revokeAllOauth(opts: RevokeAllOpts): Promise<{
  access: number; refresh: number; clients: number;
}> {
  // Build optional condition fragments using the sql tag so values are
  // bound as parameters (not interpolated as strings).
  const userFilter = opts.userId !== undefined
    ? sql` AND user_id = ${opts.userId}`
    : sql``;
  const clientFilter = opts.clientId !== undefined
    ? sql` AND client_id = ${opts.clientId}`
    : sql``;
  const clientCreatorFilter = opts.userId !== undefined
    ? sql` AND created_by_user_id = ${opts.userId}`
    : sql``;

  if (opts.dryRun) {
    const at = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int n FROM oauth_access_tokens WHERE revoked_at IS NULL${userFilter}${clientFilter}`,
    );
    const rt = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int n FROM oauth_refresh_tokens WHERE revoked_at IS NULL${userFilter}${clientFilter}`,
    );
    const cl = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int n FROM oauth_clients WHERE revoked_at IS NULL${clientCreatorFilter}${clientFilter}`,
    );
    return {
      access: (at.rows[0] as { n: number }).n,
      refresh: (rt.rows[0] as { n: number }).n,
      clients: (cl.rows[0] as { n: number }).n,
    };
  }

  const at = await db.execute(
    sql`UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL${userFilter}${clientFilter}`,
  );
  const rt = await db.execute(
    sql`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL${userFilter}${clientFilter}`,
  );
  const cl = await db.execute(
    sql`UPDATE oauth_clients SET revoked_at = NOW() WHERE revoked_at IS NULL${clientCreatorFilter}${clientFilter}`,
  );
  return {
    access: at.rowCount ?? 0,
    refresh: rt.rowCount ?? 0,
    clients: cl.rowCount ?? 0,
  };
}

// ==== Refresh token lookup (used by clipnest-mcp/oauth/token.ts handleRefresh) ====

export interface RefreshTokenRow {
  userId: number;
  clientId: string;
  scope: string;
  familyId: string;
  expiresAt: Date;
  rotatedTo: Buffer | null;
  revokedAt: Date | null;
  /** Generation frozen at grant issuance; carried forward across rotations. */
  tokenGeneration: number;
}

/**
 * Look up a refresh token by its hash. Returns null if not found.
 * The caller is responsible for all validity/rotation checks.
 */
export async function getRefreshTokenByHash(tokenHash: Buffer): Promise<RefreshTokenRow | null> {
  const [row] = await db
    .select({
      userId: oauthRefreshTokens.userId,
      clientId: oauthRefreshTokens.clientId,
      scope: oauthRefreshTokens.scope,
      familyId: oauthRefreshTokens.familyId,
      expiresAt: oauthRefreshTokens.expiresAt,
      rotatedTo: oauthRefreshTokens.rotatedTo,
      revokedAt: oauthRefreshTokens.revokedAt,
      tokenGeneration: oauthRefreshTokens.tokenGeneration,
    })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
  return row ?? null;
}

// ==== Refresh token family-id lookup (used by clipnest-mcp/oauth/revoke.ts) ====

export interface RefreshTokenFamilyRow {
  familyId: string;
  userId: number;
  clientId: string;
}

/**
 * Fetch only the family_id, user_id, and client_id for a refresh token.
 * Returns null if not found. Used by the revoke endpoint before revoking
 * the whole token family.
 */
export async function getRefreshTokenFamilyByHash(
  tokenHash: Buffer,
): Promise<RefreshTokenFamilyRow | null> {
  const [row] = await db
    .select({
      familyId: oauthRefreshTokens.familyId,
      userId: oauthRefreshTokens.userId,
      clientId: oauthRefreshTokens.clientId,
    })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
  return row ?? null;
}

// ==== MCP Audit Log ====
// (audit functions included here as audit log is tightly coupled to OAuth flows;
//  can be moved to admin domain in a future task)

export interface AuditLogInput {
  userId: number | null;
  clientId: string | null;
  action: string;
  detailsJson: Record<string, unknown>;
  ip: string | null;
}

/** Write an MCP audit log entry. */
export async function writeAuditLog(i: AuditLogInput): Promise<void> {
  await db.insert(mcpAuditLog).values({
    userId: i.userId,
    clientId: i.clientId,
    action: i.action,
    detailsJson: i.detailsJson,
    ip: i.ip,
  });
}
