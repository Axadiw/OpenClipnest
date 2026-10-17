import { createHash, randomBytes } from 'crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintOpaqueToken(prefix: 'mcp_at_' | 'mcp_rt_' | 'mcp_ac_'): string {
  return prefix + base64url(randomBytes(32));
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function parseTokenPrefix(token: string): string {
  return hashToken(token).toString('hex').slice(0, 8);
}
