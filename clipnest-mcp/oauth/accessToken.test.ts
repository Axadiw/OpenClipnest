import { describe, it, expect } from 'vitest';
import { mintOpaqueToken, hashToken, parseTokenPrefix } from './accessToken.js';

describe('opaque access token', () => {
  it('mintOpaqueToken returns mcp_at_<base64url> of expected length', () => {
    const tok = mintOpaqueToken('mcp_at_');
    expect(tok.startsWith('mcp_at_')).toBe(true);
    expect(tok.length).toBeGreaterThanOrEqual(40);
  });

  it('hashToken is deterministic sha256', () => {
    const a = hashToken('abc');
    const b = hashToken('abc');
    expect(a.equals(b)).toBe(true);
  });

  it('hashToken differs for different inputs', () => {
    expect(hashToken('a').equals(hashToken('b'))).toBe(false);
  });

  it('parseTokenPrefix returns the first 8 chars of the hex hash for logging', () => {
    const tok = 'mcp_at_xyz';
    expect(parseTokenPrefix(tok)).toMatch(/^[0-9a-f]{8}$/);
  });
});
