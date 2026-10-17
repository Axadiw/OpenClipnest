import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { __setJwtSecretForTest } from '../db/queries/settings.js';
import { generateMediaToken, generateMcpMediaToken, verifyToken } from './auth.js';
import { CONFIG } from '../config.js';
import type { JwtPayload } from '../types.js';

const PAYLOAD: JwtPayload = {
  userId: 42,
  userUuid: '00000000-0000-0000-0000-000000000042',
  email: 'auth-test@example.com',
  isAdmin: false,
  tokenGen: 7,
};

const EVENT_ID = 'evt-abc-123';

describe('media token TTLs', () => {
  beforeAll(() => {
    __setJwtSecretForTest('test-jwt-secret-for-auth-unit-tests');
  });

  it('generateMediaToken (SPA path) still produces a 15-min token', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = generateMediaToken(PAYLOAD, EVENT_ID);
    const decoded = jwt.decode(token) as { exp: number; iat: number; mediaEventId: string; kind: string };
    expect(decoded.kind).toBe('media');
    expect(decoded.mediaEventId).toBe(EVENT_ID);
    // exp should be roughly `now + 900s`; allow a few-second skew.
    expect(decoded.exp - before).toBeGreaterThanOrEqual(CONFIG.mediaTokenExpirySeconds - 5);
    expect(decoded.exp - before).toBeLessThanOrEqual(CONFIG.mediaTokenExpirySeconds + 5);
    // The 15-min default must remain untouched.
    expect(CONFIG.mediaTokenExpirySeconds).toBe(900);
  });

  it('generateMcpMediaToken (MCP path) produces a 2-min token', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = generateMcpMediaToken(PAYLOAD, EVENT_ID, 'fam-123');
    const decoded = jwt.decode(token) as { exp: number; iat: number; mediaEventId: string; mcpFamilyId: string; kind: string };
    expect(decoded.kind).toBe('media');
    expect(decoded.mediaEventId).toBe(EVENT_ID);
    expect(decoded.mcpFamilyId).toBe('fam-123');
    // exp should be roughly `now + 120s`; allow a few-second skew.
    expect(decoded.exp - before).toBeGreaterThanOrEqual(CONFIG.mcpMediaTokenExpirySeconds - 5);
    expect(decoded.exp - before).toBeLessThanOrEqual(CONFIG.mcpMediaTokenExpirySeconds + 5);
    expect(CONFIG.mcpMediaTokenExpirySeconds).toBe(120);
  });

  it('generateMcpMediaToken output is verifiable by verifyToken', () => {
    const token = generateMcpMediaToken(PAYLOAD, EVENT_ID, 'fam-123');
    const verified = verifyToken(token);
    expect(verified.userId).toBe(PAYLOAD.userId);
    expect(verified.userUuid).toBe(PAYLOAD.userUuid);
    expect(verified.email).toBe(PAYLOAD.email);
    expect(verified.mediaEventId).toBe(EVENT_ID);
    expect(verified.mcpFamilyId).toBe('fam-123');
    expect(verified.kind).toBe('media');
  });

  it('MCP token TTL is strictly shorter than the SPA token TTL', () => {
    // This is the security property the fix is shipping — keep it pinned.
    expect(CONFIG.mcpMediaTokenExpirySeconds).toBeLessThan(CONFIG.mediaTokenExpirySeconds);
  });
});
