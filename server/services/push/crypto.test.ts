import { describe, it, expect } from 'vitest';
import { story } from '../../testing/story.js';
import { encryptForDevice, decryptWithDeviceKey, generateDeviceKeyPair } from './crypto.js';

describe('push payload encryption', () => {
  it('round-trips a payload through the device key pair', (ctx) => {
    story(ctx, 'Serwer szyfruje treść pusha kluczem publicznym urządzenia; tylko aplikacja z kluczem prywatnym ją odczyta — przekaźnik i APNs/FCM widzą wyłącznie szyfrogram.');
    const device = generateDeviceKeyPair();
    const plaintext = Buffer.from(JSON.stringify({ kind: 'new_recording', camera: 'Driveway', eventId: 'evt-1' }));
    const msg = encryptForDevice(device.publicKey, plaintext);
    expect(msg.v).toBe(1);
    expect(decryptWithDeviceKey(device.privateKey, msg)).toEqual(plaintext);
  });

  it('produces a fresh ephemeral key and nonce per message', () => {
    const device = generateDeviceKeyPair();
    const a = encryptForDevice(device.publicKey, Buffer.from('x'));
    const b = encryptForDevice(device.publicKey, Buffer.from('x'));
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects ciphertext for a different device or tampered bytes', () => {
    const device = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const msg = encryptForDevice(device.publicKey, Buffer.from('secret'));
    expect(() => decryptWithDeviceKey(other.privateKey, msg)).toThrow();
    const tampered = { ...msg, ct: msg.ct.slice(0, -2) + (msg.ct.endsWith('A') ? 'BB' : 'AA') };
    expect(() => decryptWithDeviceKey(device.privateKey, tampered)).toThrow();
  });
});
