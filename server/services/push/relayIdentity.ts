// server/services/push/relayIdentity.ts
//
// This server's identity at the push relay: an Ed25519 key pair generated on
// first use and the instance id the relay assigned to its public key. Both
// are kept in the `settings` table, so they survive restarts and are covered
// by the database backup.
import { createHmac, hkdfSync } from 'node:crypto';
import { getSetting, setSetting } from '../../db/queries/settings.js';
import { generateInstanceKeyPair, signWith } from './relayProtocol.js';

const KEY_PRIVATE = 'push_relay_private_key';
const KEY_PUBLIC = 'push_relay_public_key';
// The instance id is only valid at the relay it was issued by.
const KEY_INSTANCE = 'push_relay_instance';
// HKDF label of the collapse-id key: a key of its own, so the signing key is
// only ever used to sign.
const COLLAPSE_ID_LABEL = 'clipnest-push collapse-id';

export interface RelayIdentity {
  instanceId: string;
  publicKey: string;
  sign: (data: string) => string;
  /** The collapse id sent for a notification thread — see {@link collapseIdFor}. */
  collapseId: (threadId: string) => string;
}

/** The collapse-id key, derived from the instance's private key (base64url PKCS#8 DER). */
export function collapseIdKey(privateKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(privateKey, 'base64url'), Buffer.alloc(0), COLLAPSE_ID_LABEL, 32));
}

/**
 * The relay collapses banners of one thread — one camera — by this id, so it
 * must be stable for the thread, but it must not reveal the camera name: a
 * plain hash can be reversed by hashing likely names ("Driveway", "Garage" …).
 * An HMAC under a key only this instance holds cannot be; the key comes from
 * the stored private key, so the id survives restarts. 22 base64url characters
 * (132 bits).
 */
export function collapseIdFor(key: Uint8Array, threadId: string): string {
  return createHmac('sha256', key).update(threadId).digest('base64url').slice(0, 22);
}

let cached: { relayUrl: string; identity: RelayIdentity } | null = null;

async function keyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const [publicKey, privateKey] = await Promise.all([getSetting(KEY_PUBLIC), getSetting(KEY_PRIVATE)]);
  if (publicKey && privateKey) return { publicKey, privateKey };
  const fresh = generateInstanceKeyPair();
  await setSetting(KEY_PRIVATE, fresh.privateKey);
  await setSetting(KEY_PUBLIC, fresh.publicKey);
  return fresh;
}

/**
 * The identity to use at `relayUrl`, registering with the relay the first
 * time (and again if the configured relay changes). Throws when the relay
 * cannot be reached — callers treat that as "push unavailable right now".
 */
export async function relayIdentity(relayUrl: string, fetchImpl: typeof fetch = fetch): Promise<RelayIdentity> {
  if (cached?.relayUrl === relayUrl) return cached.identity;
  const { publicKey, privateKey } = await keyPair();

  let instanceId: string | undefined;
  const stored = await getSetting(KEY_INSTANCE);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { relayUrl?: string; instanceId?: string };
      if (parsed.relayUrl === relayUrl) instanceId = parsed.instanceId;
    } catch { /* re-register */ }
  }
  if (!instanceId) {
    const res = await fetchImpl(`${relayUrl}/v1/instances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey }),
    });
    if (!res.ok) throw new Error(`push relay refused the instance registration: HTTP ${res.status}`);
    instanceId = ((await res.json()) as { instanceId: string }).instanceId;
    await setSetting(KEY_INSTANCE, JSON.stringify({ relayUrl, instanceId }));
  }

  const collapseKey = collapseIdKey(privateKey);
  const identity: RelayIdentity = {
    instanceId,
    publicKey,
    sign: (data) => signWith(privateKey, data),
    collapseId: (threadId) => collapseIdFor(collapseKey, threadId),
  };
  cached = { relayUrl, identity };
  return identity;
}
