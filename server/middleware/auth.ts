import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';
import { getTokenGeneration } from '../db/queries/users.js';
import { isMcpFamilyActive } from '../db/queries/oauth.js';
import { getSessionAuthState } from '../db/queries/sessions.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = verifyToken(token);
    // Refresh tokens may only be sent to /auth/refresh — never as a Bearer on
    // any other route. A stolen access token that leaked should NOT get a way
    // to refresh itself just because it was presented here.
    if (payload.kind === 'refresh') {
      res.status(401).json({ error: 'Wrong token kind' });
      return;
    }
    // A token bound to a device session also needs that session to stand: a
    // sign-out on this device ends it at once, not when the access token expires.
    if (payload.tokenGen != null && !payload.mediaEventId && payload.sid) {
      getSessionAuthState(payload.userId, payload.sid).then(state => {
        if (state.tokenGeneration !== payload.tokenGen || !state.sessionActive) {
          res.status(401).json({ error: 'Token revoked' });
          return;
        }
        req.user = payload;
        next();
      }).catch(() => {
        res.status(401).json({ error: 'Authentication error' });
      });
      return;
    }
    // Verify token generation (skip for media tokens which inherit the gen from session token)
    if (payload.tokenGen != null && !payload.mediaEventId) {
      getTokenGeneration(payload.userId).then(currentGen => {
        if (currentGen !== payload.tokenGen) {
          res.status(401).json({ error: 'Token revoked' });
          return;
        }
        req.user = payload;
        next();
      }).catch(() => {
        res.status(401).json({ error: 'Authentication error' });
      });
      return;
    }
    // MCP-issued media tokens are bound to the OAuth grant's refresh-token
    // family. Reject immediately once that family is revoked (client deleted /
    // grant revoked) instead of waiting out the token's TTL.
    if (payload.mediaEventId && payload.mcpFamilyId) {
      isMcpFamilyActive(payload.mcpFamilyId).then(active => {
        if (!active) {
          res.status(401).json({ error: 'Token revoked' });
          return;
        }
        req.user = payload;
        next();
      }).catch(() => {
        res.status(401).json({ error: 'Authentication error' });
      });
      return;
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function extractToken(req: Request): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Fall back to short-lived media token query parameter (for <video>/<img> tags)
  const mediaToken = req.query.media_token;
  if (typeof mediaToken === 'string' && mediaToken.length > 0) {
    return mediaToken;
  }
  return null;
}
