import type { Request, Response, NextFunction } from 'express';
import { getAccessTokenByHash, getTokenGeneration } from '../db/queries.js';
import { hashToken } from '../oauth/accessToken.js';
import { MCP_CONFIG } from '../config.js';

const PRM_URL = `${MCP_CONFIG.publicMcpUrl}/.well-known/oauth-protected-resource`;
const EXPECTED_RESOURCE = `${MCP_CONFIG.publicMcpUrl}/mcp`;

export interface McpAuthContext {
  userId: number;
  clientId: string;
  scope: string;
  familyId: string;
  resource: string;
}

// Augment Express Request to carry auth context once validated.
declare global {
   
  namespace Express {
    interface Request {
      mcpAuth?: McpAuthContext;
      tokenForLimit?: string;
    }
  }
}

function fail(res: Response, code: string, desc: string): void {
  res.set(
    'WWW-Authenticate',
    `Bearer error="${code}", error_description="${desc}", resource_metadata="${PRM_URL}"`,
  );
  res.status(401).json({ error: code, error_description: desc });
}

export async function bearerAuthMcp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  // Step 1: missing or not a Bearer token
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    fail(res, 'invalid_token', 'Bearer token required');
    return;
  }

  // Step 2: check token format prefix
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token.startsWith('mcp_at_')) {
    fail(res, 'invalid_token', 'unknown token format');
    return;
  }

  // Step 3: look up in DB
  const tokenHash = hashToken(token);
  const row = await getAccessTokenByHash(tokenHash);
  if (row === null) {
    fail(res, 'invalid_token', 'unknown token');
    return;
  }

  // Step 4: revocation check
  if (row.revokedAt !== null) {
    fail(res, 'invalid_token', 'revoked');
    return;
  }

  // Step 5: expiry check
  if (new Date(row.expiresAt) <= new Date()) {
    fail(res, 'invalid_token', 'expired');
    return;
  }

  // Step 5b: global-revocation check. The main app bumps users.token_generation
  // on password change, passkey removal, account deletion, and POST /auth/logout
  // to revoke every outstanding session. The generation captured on this grant
  // at issuance (frozen across refresh rotations) must still match the user's
  // current generation — otherwise the credential was revoked and this token,
  // though not individually expired/revoked, must be rejected.
  const currentGeneration = await getTokenGeneration(row.userId);
  if (currentGeneration > row.tokenGeneration) {
    fail(res, 'invalid_token', 'revoked');
    return;
  }

  // Step 6: populate auth context
  req.mcpAuth = {
    userId: row.userId,
    clientId: row.clientId,
    scope: row.scope,
    familyId: row.familyId,
    resource: EXPECTED_RESOURCE,
  };

  // Step 7: first 16 hex chars of sha256 hash for per-token rate limiting
  req.tokenForLimit = tokenHash.toString('hex').slice(0, 16);

  // Step 8: pass through
  next();
}
