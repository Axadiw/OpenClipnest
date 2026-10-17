// server/services/push/relayProtocol.ts
//
// Wire protocol between a self-hosted server and the Clipnest push relay (v1).
//
// Why a relay at all: Apple and Google only accept pushes signed with the
// app publisher's credentials, so a self-hosted server cannot reach the
// store-signed apps on its own. The relay holds those credentials and
// forwards what instances send it. The protocol is built so that the relay
// learns as little as possible and an instance can do as little harm as
// possible:
//
//   - Instance identity is an Ed25519 key pair the server generates once.
//     `POST /v1/instances { publicKey }` → `{ instanceId }`.
//   - A device's push token never reaches the instance. The app asks its own
//     server for a signed registration ticket and presents it to the relay
//     together with the token: `POST /v1/devices`. An instance can therefore
//     only ever push to devices whose owner chose to register through it.
//   - Every send is signed by the instance and carries a timestamp:
//     `POST /v1/send`. The message itself is encrypted end to end for the
//     device (crypto.ts) — the relay forwards ciphertext.
//
// The strings below are what gets signed; both sides must build them the same
// way. Fields are joined with `|` and none of them can contain one.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const PROTOCOL = 'clipnest-push-v1';
/** A registration ticket is presented to the relay within this window. */
export const TICKET_TTL_SECONDS = 600;
/** Accepted clock skew on a signed send. */
export const SEND_SKEW_SECONDS = 300;

export const registerString = (instanceId: string, deviceId: string, platform: string, expires: number): string =>
  [PROTOCOL, 'register', instanceId, deviceId, platform, String(expires)].join('|');

export const sendString = (instanceId: string, deviceId: string, timestamp: number, message: string): string =>
  [PROTOCOL, 'send', instanceId, deviceId, String(timestamp), createHash('sha256').update(message).digest('hex')].join('|');

/** New instance key pair, both halves as base64url DER. */
export function generateInstanceKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

export function signWith(privateKey: string, data: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(data), key).toString('base64url');
}

export function verifyWith(publicKey: string, data: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(data), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
