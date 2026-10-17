// server/services/push/relayTransport.ts
//
// Delivery through the Clipnest push relay — the default transport of a
// self-hosted install (protocol: relayProtocol.ts). The relay gets the id it
// knows the device by and an end-to-end encrypted message, signed by this
// instance. It never gets a camera name, an event id or a media token, and
// this server never holds the device's push token.
//
// A device that has not registered with the relay (no `device.relay`) cannot
// be reached and is reported as such — never pruned, the app may register later.
import type { PushDevice, PushOptions, PushTransport, SendPushResult } from './types.js';
import { encryptForDevice } from './crypto.js';
import { sendString } from './relayProtocol.js';
import { relayIdentity, type RelayIdentity } from './relayIdentity.js';

/** The configured relay base URL (no trailing slash), or null when push is off. */
export function relayUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = (env.CLIPNEST_PUSH_RELAY_URL || '').trim().replace(/\/$/, '');
  return url || null;
}

/** What the app decrypts: the notification, minus anything transport-specific. */
export function relayPlaintext(payload: PushOptions): Uint8Array {
  const { title, body, kind, category, threadId, custom, titleLocKey, locKey, locArgs } = payload;
  return Buffer.from(JSON.stringify({ title, body, kind, category, threadId, custom, titleLocKey, locKey, locArgs }));
}

export function createRelayTransport(
  relayUrl: string | null,
  deps: { fetch?: typeof fetch; identity?: (relayUrl: string) => Promise<RelayIdentity>; now?: () => number } = {},
): PushTransport {
  const fetchImpl = deps.fetch ?? fetch;
  const identityOf = deps.identity ?? ((url: string) => relayIdentity(url, fetchImpl));
  const now = deps.now ?? Date.now;
  return {
    name: 'relay',
    configured: () => relayUrl !== null,
    describeMissing: () => 'set CLIPNEST_PUSH_RELAY_URL to the Clipnest push relay',
    async send(device: PushDevice, payload: PushOptions): Promise<SendPushResult> {
      if (!relayUrl) return { ok: false, status: 0, reason: 'relay_not_configured', shouldPrune: false };
      if (!device.relay) return { ok: false, status: 0, reason: 'device_not_registered_with_relay', shouldPrune: false };
      try {
        const identity = await identityOf(relayUrl);
        // The message is signed as an opaque string so both sides hash the
        // exact same bytes — no JSON canonicalisation to disagree about.
        const message = JSON.stringify(encryptForDevice(device.relay.publicKey, relayPlaintext(payload)));
        const timestamp = Math.floor(now() / 1000);
        const res = await fetchImpl(`${relayUrl}/v1/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instanceId: identity.instanceId,
            deviceId: device.relay.deviceId,
            timestamp,
            message,
            // The worker groups banners per camera via `threadId`; the relay
            // gets a keyed tag for it, never the camera name.
            collapseId: payload.threadId ? identity.collapseId(payload.threadId) : undefined,
            signature: identity.sign(sendString(identity.instanceId, device.relay.deviceId, timestamp, message)),
          }),
        });
        if (res.ok) return { ok: true, status: res.status, shouldPrune: false };
        // 410: the platform reported the token dead, the relay dropped it.
        return { ok: false, status: res.status, reason: (await res.text().catch(() => '')).slice(0, 200), shouldPrune: res.status === 410 };
      } catch (err) {
        return { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err), shouldPrune: false };
      }
    },
    async close() {},
  };
}
