import { createHash, randomBytes } from 'crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateRandomVerifier(): string {
  return base64url(randomBytes(48));
}

export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const actual = challengeFromVerifier(verifier);
  if (actual.length !== expectedChallenge.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ expectedChallenge.charCodeAt(i);
  return mismatch === 0;
}
