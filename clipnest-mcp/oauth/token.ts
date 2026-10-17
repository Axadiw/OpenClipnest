import type { Express, Request, Response } from 'express';
import {
  claimAuthCodeAtomic, insertAccessToken, insertRefreshToken,
  rotateRefreshAtomic, revokeRefreshFamily, writeAuditLog,
  getRefreshTokenByHash, getTokenGeneration,
} from '../db/queries.js';
import { mintOpaqueToken, hashToken } from './accessToken.js';
import { verifyPkceS256 } from './pkce.js';
import { MCP_CONFIG } from '../config.js';

const ACCESS_TTL_SECONDS = 900;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const EXPECTED_RESOURCE = `${MCP_CONFIG.publicMcpUrl}/mcp`;

export function mountToken(app: Express): void {
  app.post('/mcp/oauth/token', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string>;
    // resource check FIRST — short-circuits both grants
    if (body.resource !== EXPECTED_RESOURCE) {
      return res.status(400).json({ error: 'invalid_target' });
    }
    const grant = body.grant_type;
    if (grant === 'authorization_code') return handleAuthCode(req, res, body);
    if (grant === 'refresh_token') return handleRefresh(req, res, body);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

async function handleAuthCode(req: Request, res: Response, body: Record<string, string>) {
  const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier } = body;

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // 1. Atomic single-use claim (must happen FIRST so brute-force can't replay)
  const codeRow = await claimAuthCodeAtomic(hashToken(code));
  if (!codeRow) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 2. Client ID check — revoke family on mismatch (confused-deputy defense)
  if (codeRow.clientId !== clientId) {
    await revokeRefreshFamily(codeRow.familyId);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 3. Redirect URI check
  if (codeRow.redirectUri !== redirectUri) {
    await revokeRefreshFamily(codeRow.familyId);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 4. PKCE S256 verification
  if (!verifyPkceS256(codeVerifier, codeRow.codeChallenge)) {
    await revokeRefreshFamily(codeRow.familyId);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // Mint tokens
  const accessToken = mintOpaqueToken('mcp_at_');
  const refreshToken = mintOpaqueToken('mcp_rt_');
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TTL_SECONDS * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TTL_SECONDS * 1000);

  // Freeze the user's current global generation onto the grant. The bearer path
  // rejects the moment users.token_generation is bumped past this.
  const tokenGeneration = await getTokenGeneration(codeRow.userId);

  await insertAccessToken({
    tokenHash: hashToken(accessToken),
    clientId,
    userId: codeRow.userId,
    scope: codeRow.scope,
    familyId: codeRow.familyId,
    expiresAt: accessExpiresAt,
    tokenGeneration,
  });

  await insertRefreshToken({
    tokenHash: hashToken(refreshToken),
    clientId,
    userId: codeRow.userId,
    scope: codeRow.scope,
    familyId: codeRow.familyId,
    expiresAt: refreshExpiresAt,
    tokenGeneration,
  });

  await writeAuditLog({
    userId: codeRow.userId,
    clientId,
    action: 'token.issue',
    detailsJson: { family: codeRow.familyId, scope: codeRow.scope },
    ip: req.ip ?? null,
  });

  return res.status(200).json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: codeRow.scope,
  });
}

async function handleRefresh(req: Request, res: Response, body: Record<string, string>) {
  const { refresh_token: refreshToken, client_id: clientId, scope: requestedScope } = body;

  if (!refreshToken || !clientId) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const oldHash = hashToken(refreshToken);

  // 1. Lookup refresh token
  const row = await getRefreshTokenByHash(oldHash);

  if (!row) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 2. Client ID mismatch → revoke family + invalid_grant
  if (row.clientId !== clientId) {
    await revokeRefreshFamily(row.familyId);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 3a. Token was already rotated (rotatedTo is set) — this is a replay/theft attempt.
  //     Revoke the whole family before rejecting.
  if (row.rotatedTo !== null) {
    await revokeRefreshFamily(row.familyId);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 3b. Token was revoked for other reasons (admin revoke, client revoke) or is expired.
  //     No family revoke needed — already handled externally or natural expiry.
  if (row.revokedAt !== null || row.expiresAt <= new Date()) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 3c. Global revocation: the user rotated credentials (password change, passkey
  //     removal, logout, account deletion) since this grant was issued, bumping
  //     users.token_generation past the value frozen on the grant. Refuse to mint
  //     a fresh access token — otherwise the 30-day refresh window would keep a
  //     phished grant alive across a credential rotation.
  const currentGeneration = await getTokenGeneration(row.userId);
  if (currentGeneration > row.tokenGeneration) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 4. Scope downgrade check — requested scope must be subset of original
  if (requestedScope !== undefined) {
    const originalScopes = new Set(row.scope.split(/\s+/).filter(Boolean));
    const requested = requestedScope.split(/\s+/).filter(Boolean);
    for (const s of requested) {
      if (!originalScopes.has(s)) {
        return res.status(400).json({ error: 'invalid_scope' });
      }
    }
  }

  const grantedScope: string = requestedScope ?? row.scope;

  // 5. Mint new tokens
  const newAccessToken = mintOpaqueToken('mcp_at_');
  const newRefreshToken = mintOpaqueToken('mcp_rt_');
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TTL_SECONDS * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TTL_SECONDS * 1000);
  const newRefreshHash = hashToken(newRefreshToken);

  // 6. Rotate atomically — detect reuse (theft)
  const rotateResult = await rotateRefreshAtomic(oldHash, newRefreshHash);

  if (rotateResult === 'reused') {
    await revokeRefreshFamily(row.familyId);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  if (rotateResult === 'unknown') {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // 7. Insert new access + refresh tokens (same family_id). Carry the grant's
  //    frozen generation forward unchanged — re-capturing the current value here
  //    would let a rotation "launder" a revoked grant back to the live generation.
  await insertAccessToken({
    tokenHash: hashToken(newAccessToken),
    clientId,
    userId: row.userId,
    scope: grantedScope,
    familyId: row.familyId,
    expiresAt: accessExpiresAt,
    tokenGeneration: row.tokenGeneration,
  });

  await insertRefreshToken({
    tokenHash: newRefreshHash,
    clientId,
    userId: row.userId,
    scope: grantedScope,
    familyId: row.familyId,
    expiresAt: refreshExpiresAt,
    tokenGeneration: row.tokenGeneration,
  });

  await writeAuditLog({
    userId: row.userId,
    clientId,
    action: 'token.refresh',
    detailsJson: { family: row.familyId, scope: grantedScope },
    ip: req.ip ?? null,
  });

  return res.status(200).json({
    access_token: newAccessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: newRefreshToken,
    scope: grantedScope,
  });
}
