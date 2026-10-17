// server/services/push/crypto.ts
//
// End-to-end encryption of push payloads. A device generates a P-256 key pair
// and registers only its public key with its server; the server encrypts each
// push for that key, so the relay (and APNs/FCM behind it) carries ciphertext
// only — camera names, event ids and media tokens never leave the two ends.
//
// Scheme (v1): ephemeral ECDH P-256 → HKDF-SHA256(shared, salt = ephemeral
// public key, info = 'clipnest-push-v1') → 32-byte AES-256-GCM key, random
// 12-byte IV, ciphertext‖tag. Everything on the wire is base64url.
import { createECDH, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const PUSH_CRYPTO_VERSION = 1 as const;
const CURVE = 'prime256v1';
const INFO = 'clipnest-push-v1';

export interface EncryptedPush {
  v: typeof PUSH_CRYPTO_VERSION;
  /** Ephemeral P-256 public key, uncompressed point (65 bytes), base64url. */
  epk: string;
  /** 12-byte AES-GCM nonce, base64url. */
  iv: string;
  /** AES-256-GCM ciphertext followed by the 16-byte tag, base64url. */
  ct: string;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function deriveKey(shared: Buffer, epk: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, epk, INFO, 32));
}

/** Encrypt `plaintext` for a device whose public key (uncompressed P-256, base64url) is `devicePublicKey`. */
export function encryptForDevice(devicePublicKey: string, plaintext: Uint8Array): EncryptedPush {
  const ephemeral = createECDH(CURVE);
  ephemeral.generateKeys();
  const epk = ephemeral.getPublicKey(); // uncompressed
  const shared = ephemeral.computeSecret(fromB64u(devicePublicKey));
  const key = deriveKey(shared, epk);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: PUSH_CRYPTO_VERSION, epk: b64u(epk), iv: b64u(iv), ct: b64u(ct) };
}

/** Counterpart of encryptForDevice — what the app does. Used by tests and tooling. */
export function decryptWithDeviceKey(devicePrivateKey: string, msg: EncryptedPush): Uint8Array {
  if (msg.v !== PUSH_CRYPTO_VERSION) throw new Error(`unsupported push crypto version ${String(msg.v)}`);
  const device = createECDH(CURVE);
  device.setPrivateKey(fromB64u(devicePrivateKey));
  const epk = fromB64u(msg.epk);
  const key = deriveKey(device.computeSecret(epk), epk);
  const ct = fromB64u(msg.ct);
  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64u(msg.iv));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Generate a device key pair (what the app does on first registration). Base64url. */
export function generateDeviceKeyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
