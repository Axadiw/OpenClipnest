import { describe, it, expect } from 'vitest';
import { verifyPkceS256, generateRandomVerifier, challengeFromVerifier } from './pkce.js';

describe('PKCE S256', () => {
  it('round-trip: a generated verifier validates against its own challenge', () => {
    const verifier = generateRandomVerifier();
    const challenge = challengeFromVerifier(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('returns false for a tampered verifier', () => {
    const verifier = generateRandomVerifier();
    const challenge = challengeFromVerifier(verifier);
    expect(verifyPkceS256(verifier + 'x', challenge)).toBe(false);
  });

  it('returns false for a tampered challenge', () => {
    const verifier = generateRandomVerifier();
    const challenge = challengeFromVerifier(verifier);
    expect(verifyPkceS256(verifier, challenge.slice(0, -1) + (challenge.slice(-1) === 'a' ? 'b' : 'a'))).toBe(false);
  });

  it('rejects verifiers shorter than 43 chars (RFC 7636)', () => {
    expect(verifyPkceS256('short', 'irrelevant')).toBe(false);
  });

  it('rejects verifiers longer than 128 chars (RFC 7636)', () => {
    expect(verifyPkceS256('a'.repeat(129), 'irrelevant')).toBe(false);
  });
});
