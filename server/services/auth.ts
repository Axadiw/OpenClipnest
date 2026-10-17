import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../db/queries/settings.js';
import { CONFIG } from '../config.js';
import type { JwtPayload } from '../types.js';

// Pre-computed hash of a random string, used to prevent timing attacks
// when the requested user doesn't exist (bcrypt.compare always runs).
export const DUMMY_HASH = '$2b$12$LJ3m4ys3Lg3DYe.mjs/aku3OfYBOmBOVFMqNPMbMiAPyrGcrJyTi6';

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, CONFIG.bcryptRounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function stripJwtClaims(payload: JwtPayload): JwtPayload {
  const { exp: _exp, iat: _iat, nbf: _nbf, ...cleaned } = payload as JwtPayload & { exp?: number; iat?: number; nbf?: number };
  return cleaned;
}

export function generateAccessToken(payload: JwtPayload): string {
  const secret = getJwtSecret();
  const clean = stripJwtClaims(payload);
  return jwt.sign({ ...clean, kind: 'access' } as object, secret, { expiresIn: CONFIG.accessTokenExpirySeconds });
}

export function generateRefreshToken(payload: JwtPayload): string {
  const secret = getJwtSecret();
  const clean = stripJwtClaims(payload);
  // Refresh tokens never carry a mediaEventId; strip it defensively in case a
  // caller passes a decoded media token.
  delete (clean as { mediaEventId?: string }).mediaEventId;
  return jwt.sign({ ...clean, kind: 'refresh' } as object, secret, { expiresIn: CONFIG.refreshTokenExpirySeconds });
}

export function generateMediaToken(payload: JwtPayload, eventId: string): string {
  const secret = getJwtSecret();
  const clean = stripJwtClaims(payload);
  return jwt.sign({ ...clean, mediaEventId: eventId, kind: 'media' } as object, secret, { expiresIn: CONFIG.mediaTokenExpirySeconds });
}

// MCP-issued media tokens are bound to the issuing OAuth refresh-token family
// via `mcpFamilyId`. The API's requireAuth rejects the token the moment that
// family is revoked (client deleted / grant revoked) — so revocation is
// synchronous.
// The short TTL (CONFIG.mcpMediaTokenExpirySeconds) remains as defense-in-depth.
export function generateMcpMediaToken(payload: JwtPayload, eventId: string, familyId: string): string {
  const secret = getJwtSecret();
  const clean = stripJwtClaims(payload);
  return jwt.sign(
    { ...clean, mediaEventId: eventId, mcpFamilyId: familyId, kind: 'media' } as object,
    secret,
    { expiresIn: CONFIG.mcpMediaTokenExpirySeconds },
  );
}

export function verifyToken(token: string): JwtPayload {
  const secret = getJwtSecret();
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
}
