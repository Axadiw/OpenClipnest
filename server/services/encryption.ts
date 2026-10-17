import crypto from 'crypto';

/**
 * Derive a 32-byte SSE-C encryption key for a user using HKDF-SHA256.
 *
 * The master key (from env) is combined with the user's unique salt (from DB)
 * to produce a deterministic, per-user key. MinIO uses this key to encrypt/decrypt
 * objects transparently via SSE-C headers.
 *
 * Security properties:
 * - Different salts → different keys (per-user isolation)
 * - Master key alone is not enough (need salt from DB)
 * - Salt alone is not enough (need master key from env)
 * - Deterministic: same inputs always produce same key (no state to track)
 */
export function deriveUserKey(masterKey: string, userSalt: string): Buffer {
  if (!masterKey) throw new Error('Encryption master key is required');
  if (!userSalt) throw new Error('User encryption salt is required');

  const ikm = Buffer.from(masterKey, 'utf-8');
  const salt = Buffer.from(userSalt, 'base64url');
  const info = Buffer.from('clipnest-sse-c-v1', 'utf-8');

  const derived = crypto.hkdfSync('sha256', ikm, salt, info, 32);
  return Buffer.from(derived);
}

/**
 * Compute SSE-C headers required by S3/MinIO for encrypted operations.
 *
 * Returns the three headers needed on every PUT/GET/HEAD/COPY:
 * - Algorithm: always AES256
 * - Key: base64-encoded 32-byte derived key
 * - Key MD5: base64-encoded MD5 of the key (for integrity verification)
 */
export function ssecHeaders(userKey: Buffer): {
  SSECustomerAlgorithm: 'AES256';
  SSECustomerKey: string;
  SSECustomerKeyMD5: string;
} {
  const keyBase64 = userKey.toString('base64');
  const keyMd5 = crypto.createHash('md5').update(userKey).digest('base64');
  return {
    SSECustomerAlgorithm: 'AES256',
    SSECustomerKey: keyBase64,
    SSECustomerKeyMD5: keyMd5,
  };
}
