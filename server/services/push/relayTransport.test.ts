import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { story } from '../../testing/story.js';
import { createRelayTransport, relayUrlFromEnv } from './relayTransport.js';
import { decryptWithDeviceKey, generateDeviceKeyPair, type EncryptedPush } from './crypto.js';
import { generateInstanceKeyPair, signWith, verifyWith, sendString } from './relayProtocol.js';
import { collapseIdFor, collapseIdKey, type RelayIdentity } from './relayIdentity.js';
import type { PushOptions } from './types.js';

const payload: PushOptions = {
  title: 'New recording', body: 'Driveway', kind: 'new_recording', category: 'recording',
  threadId: 'Driveway', mutableContent: true, custom: { eventId: 'evt-1', camera: 'Driveway' },
};
const instance = generateInstanceKeyPair();
const identityOf = (keys: { publicKey: string; privateKey: string }): RelayIdentity => {
  const collapseKey = collapseIdKey(keys.privateKey);
  return {
    instanceId: 'inst-1',
    publicKey: keys.publicKey,
    sign: (d: string) => signWith(keys.privateKey, d),
    collapseId: (t: string) => collapseIdFor(collapseKey, t),
  };
};
const identity = async () => identityOf(instance);
const NOW = 1_800_000_000_000;

/** What the relay receives as the collapse id for `payload` from `keys`' instance. */
async function sentCollapseId(keys: { publicKey: string; privateKey: string }, p: PushOptions = payload): Promise<unknown> {
  const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
  const t = createRelayTransport('https://push.example', { fetch: fetchMock as unknown as typeof fetch, identity: async () => identityOf(keys) });
  const device = generateDeviceKeyPair();
  await t.send({ deviceToken: 'relay:d', platform: 'ios', supportsLocKeys: true, relay: { deviceId: 'd', publicKey: device.publicKey } }, p);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)).collapseId;
}

describe('relay transport', () => {
  it('is unconfigured until a relay URL is set', () => {
    expect(relayUrlFromEnv({})).toBeNull();
    expect(relayUrlFromEnv({ CLIPNEST_PUSH_RELAY_URL: 'https://push.example/' })).toBe('https://push.example');
    expect(createRelayTransport(null).configured()).toBe(false);
  });

  it('sends a signed, end-to-end encrypted message — never the token, never the camera name', async (ctx) => {
    story(ctx, 'Przekaźnik dostaje id urządzenia, szyfrogram i podpis instancji. Nie ma w tym tokenu APNs/FCM (serwer go nie zna) ani nazwy kamery. Aplikacja odszyfrowuje treść swoim kluczem prywatnym, a przekaźnik może sprawdzić podpis kluczem publicznym instancji.');
    const device = generateDeviceKeyPair();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const t = createRelayTransport('https://push.example', { fetch: fetchMock as unknown as typeof fetch, identity, now: () => NOW });
    const r = await t.send({ deviceToken: 'relay:dev-1', platform: 'ios', supportsLocKeys: true, relay: { deviceId: 'dev-1', publicKey: device.publicKey } }, payload);
    expect(r.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://push.example/v1/send');
    const bodyText = String(init.body);
    expect(bodyText).not.toContain('Driveway');
    const body = JSON.parse(bodyText);
    expect(body).toMatchObject({ instanceId: 'inst-1', deviceId: 'dev-1', timestamp: NOW / 1000, collapseId: collapseIdFor(collapseIdKey(instance.privateKey), 'Driveway') });
    expect(verifyWith(instance.publicKey, sendString('inst-1', 'dev-1', body.timestamp, body.message), body.signature)).toBe(true);
    const clear = JSON.parse(Buffer.from(decryptWithDeviceKey(device.privateKey, JSON.parse(body.message) as EncryptedPush)).toString());
    expect(clear).toMatchObject({ kind: 'new_recording', custom: { eventId: 'evt-1', camera: 'Driveway' } });
  });

  it('sends a collapse id nobody can turn back into the camera name', async (ctx) => {
    story(ctx, 'Przekaźnik grupuje bannery jednej kamery po collapseId. Zwykły skrót nazwy kamery dałoby się odwrócić słownikiem („Driveway”, „Garage”…), więc to HMAC kluczem, który ma tylko ta instancja: ten sam dla kamery przy każdym wysłaniu, inny w każdej instancji, a z samej nazwy niemożliwy do wyliczenia.');
    const id = await sentCollapseId(instance);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Not the dictionary-reversible plain hash of the camera name.
    expect(id).not.toBe(createHash('sha256').update('Driveway').digest('base64url').slice(0, 22));
    // Not an HMAC under the raw signing key either: the collapse key is derived.
    expect(id).not.toBe(collapseIdFor(Buffer.from(instance.privateKey, 'base64url'), 'Driveway'));
    // Stable for the thread, distinct per thread and per instance.
    expect(await sentCollapseId(instance)).toBe(id);
    expect(await sentCollapseId(instance, { ...payload, threadId: 'Garage' })).not.toBe(id);
    expect(await sentCollapseId(generateInstanceKeyPair())).not.toBe(id);
    // No thread, no collapse id.
    expect(await sentCollapseId(instance, { ...payload, threadId: undefined })).toBeUndefined();
  });

  it('a tampered message no longer matches the signature', async () => {
    const data = sendString('inst-1', 'dev-1', 1, 'message');
    const sig = signWith(instance.privateKey, data);
    expect(verifyWith(instance.publicKey, data, sig)).toBe(true);
    expect(verifyWith(instance.publicKey, sendString('inst-1', 'dev-1', 1, 'other'), sig)).toBe(false);
    expect(verifyWith(generateInstanceKeyPair().publicKey, data, sig)).toBe(false);
  });

  it('reports an unregistered device without pruning it, prunes on 410, survives a relay outage', async () => {
    const device = generateDeviceKeyPair();
    const relayDevice = { deviceToken: 'relay:d', platform: 'ios', supportsLocKeys: true, relay: { deviceId: 'd', publicKey: device.publicKey } };
    const gone = createRelayTransport('https://push.example', { fetch: vi.fn(async () => new Response('gone', { status: 410 })) as unknown as typeof fetch, identity });
    expect(await gone.send({ deviceToken: 'x', platform: 'ios', supportsLocKeys: false }, payload))
      .toMatchObject({ ok: false, reason: 'device_not_registered_with_relay', shouldPrune: false });
    expect(await gone.send(relayDevice, payload)).toMatchObject({ ok: false, status: 410, shouldPrune: true });
    const down = createRelayTransport('https://push.example', { fetch: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch, identity });
    expect(await down.send(relayDevice, payload)).toMatchObject({ ok: false, status: 0, shouldPrune: false });
  });
});
