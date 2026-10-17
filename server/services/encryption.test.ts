import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { deriveUserKey, ssecHeaders } from './encryption.js';
import { story } from '../testing/story.js';

describe('deriveUserKey', () => {
  const masterKey = 'test-master-key-for-unit-tests';
  const salt1 = crypto.randomBytes(32).toString('base64url');
  const salt2 = crypto.randomBytes(32).toString('base64url');

  it('returns a 32-byte Buffer', (ctx) => {
    story(ctx, 'Klucz szyfrujący SSE-C musi mieć dokładnie 32 bajty — długość narzucona przez AES-256, bez której S3 odrzuci obiekt.');
    const key = deriveUserKey(masterKey, salt1);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it('is deterministic (same inputs → same key)', (ctx) => {
    story(ctx, 'Ten sam master key i sól zawsze generują identyczny klucz — warunek konieczny, żeby odszyfrować nagranie zapisane wcześniej tą samą kombinacją.');
    const key1 = deriveUserKey(masterKey, salt1);
    const key2 = deriveUserKey(masterKey, salt1);
    expect(key1.equals(key2)).toBe(true);
  });

  it('different salts produce different keys', (ctx) => {
    story(ctx, 'Każdy user ma własną sól — nawet gdy master key wycieknie częściowo, klucze dla poszczególnych kont pozostają niezależne i nie dają się pomieszać.');
    const key1 = deriveUserKey(masterKey, salt1);
    const key2 = deriveUserKey(masterKey, salt2);
    expect(key1.equals(key2)).toBe(false);
  });

  it('different master keys produce different keys', (ctx) => {
    story(ctx, 'Zmiana master keya (np. przy rotacji sekretów) skutkuje innym kluczem pochodnym — kluczowy warunek, żeby nowe operacje nie kolidowały ze starymi obiektami.');
    const key1 = deriveUserKey('master-key-A', salt1);
    const key2 = deriveUserKey('master-key-B', salt1);
    expect(key1.equals(key2)).toBe(false);
  });

  it('throws if master key is empty', (ctx) => {
    story(ctx, 'Pusty master key musi wywołać błąd — inaczej uruchomiona aplikacja szyfrowałaby nagrania trywialnym kluczem, równoznacznie z brakiem szyfrowania.');
    expect(() => deriveUserKey('', salt1)).toThrow('master key');
  });

  it('throws if salt is empty', (ctx) => {
    story(ctx, 'Brak soli dla usera jest błędem krytycznym — w przeciwnym razie wszystkie konta dostałyby ten sam klucz, co zlikwidowałoby izolację między tenantami.');
    expect(() => deriveUserKey(masterKey, '')).toThrow('salt');
  });
});

describe('ssecHeaders', () => {
  it('returns correct structure', (ctx) => {
    story(ctx, 'Nagłówki SSE-C do S3 muszą mieć poprawne pola (algorithm, key, key-MD5) — to kontrakt z AWS, bez którego PUT/GET się nie powiedzie.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const headers = ssecHeaders(key);

    expect(headers.SSECustomerAlgorithm).toBe('AES256');
    expect(typeof headers.SSECustomerKey).toBe('string');
    expect(typeof headers.SSECustomerKeyMD5).toBe('string');
  });

  it('key is base64-encoded 32 bytes', (ctx) => {
    story(ctx, 'Klucz SSE-C jest base64 z 32-bajtowego bufora — dokładnie taki format wymaga S3 i każda pomyłka zablokowałaby upload/download.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const headers = ssecHeaders(key);

    const decoded = Buffer.from(headers.SSECustomerKey, 'base64');
    expect(decoded.length).toBe(32);
    expect(decoded.equals(key)).toBe(true);
  });

  it('MD5 matches the key', (ctx) => {
    story(ctx, 'S3 sprawdza MD5 klucza SSE-C jako checksum — jeśli nie zgadza się z zawartością, żądanie zostaje odrzucone, więc kalkulacja MD5 musi być zgodna z kluczem.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const headers = ssecHeaders(key);

    const expectedMd5 = crypto.createHash('md5').update(key).digest('base64');
    expect(headers.SSECustomerKeyMD5).toBe(expectedMd5);
  });

  it('same key always produces same headers', (ctx) => {
    story(ctx, 'Dwa wywołania z identycznym kluczem dają identyczne nagłówki — warunek, aby kolejne żądania do tego samego obiektu S3 mogły użyć cache\'u i nie dublowały pracy.');
    const key = deriveUserKey('test-key', crypto.randomBytes(32).toString('base64url'));
    const h1 = ssecHeaders(key);
    const h2 = ssecHeaders(key);
    expect(h1).toEqual(h2);
  });
});
