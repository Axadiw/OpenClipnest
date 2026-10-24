import { createSession } from '../db/queries/sessions.js';
import { generateAccessToken, generateRefreshToken } from './auth.js';
import type { JwtPayload } from '../types.js';

/**
 * Sign a device in: open a session and issue the access + refresh pair bound
 * to it through the `sid` claim. Every sign-in path goes through here, so
 * signing out on that device can end exactly this session.
 */
export async function issueSessionTokens(
  payload: Omit<JwtPayload, 'sid'>,
): Promise<{ token: string; refreshToken: string }> {
  const sid = await createSession(payload.userId);
  const bound = { ...payload, sid };
  return { token: generateAccessToken(bound), refreshToken: generateRefreshToken(bound) };
}
