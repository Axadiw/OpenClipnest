import crypto from 'crypto';

// Apple-TV device-code helpers. The TV shows a short USER code; the user types
// it on the web app's /tv page. The DEVICE code is the long secret the TV polls with.
//
// `user_code` alphabet excludes the ambiguous glyphs I, L, O, 0, 1 so a code
// copied off a 10-foot screen can't be misread. 31 symbols × 8 chars ≈ 8.5×10¹¹
// keyspace; combined with the 5-minute TTL, single-use consumption and the
// per-IP / per-device poll limits, brute-forcing a live code is infeasible.
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;

/** A fresh canonical (un-dashed, upper-case) 8-char user code. */
export function generateUserCode(): string {
  const bytes = crypto.randomBytes(USER_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    // Modulo bias across 256→31 is negligible for a human-readable code with a
    // 5-minute lifetime; the entropy floor is set by the TTL + rate limits.
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  }
  return out;
}

/** Display form: `K7QF3M9P` → `K7QF-3M9P` (two groups of four). */
export function formatUserCode(canonical: string): string {
  const mid = Math.floor(canonical.length / 2);
  return `${canonical.slice(0, mid)}-${canonical.slice(mid)}`;
}

/**
 * Normalize user-typed input to the canonical form, or null if it can't be a
 * valid code. Accepts lower-case, dashes and surrounding whitespace; rejects
 * the wrong length or any out-of-alphabet character (so junk codes are bounced
 * before they ever hit the database).
 */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== USER_CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!USER_CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** A long, opaque, url-safe secret the TV polls the token endpoint with. */
export function generateDeviceCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}
