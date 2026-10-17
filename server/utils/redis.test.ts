import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { story } from '../testing/story.js';
import { getRedis, closeRedis, getRedisUrl } from './redis.js';

// These tests exercise AUTH wiring only — they construct lazy clients
// (no connection) and inspect the resolved ioredis options. No live Redis.
describe('getRedis — AUTH password wiring (NOAUTH-on-reconnect fix)', () => {
  const ORIG_URL = process.env.REDIS_URL;
  const ORIG_PW = process.env.REDIS_PASSWORD;

  beforeEach(async () => {
    await closeRedis();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await closeRedis();
    if (ORIG_URL === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = ORIG_URL;
    if (ORIG_PW === undefined) delete process.env.REDIS_PASSWORD; else process.env.REDIS_PASSWORD = ORIG_PW;
  });

  it('supplies REDIS_PASSWORD when REDIS_URL has no auth segment (the gap path)', async (ctx) => {
    story(ctx, 'Sedno bugu NOAUTH: entrypoint budujący klienta z gołego ConfigMap REDIS_URL (bez hasła). Jawna opcja password z REDIS_PASSWORD domyka lukę — ioredis re-AUTH-uje nią przy każdym reconnect.');
    process.env.REDIS_URL = 'redis://clipnest-redis:6379';
    process.env.REDIS_PASSWORD = 'secret-from-env';
    const client = getRedis({ lazyConnect: true });
    expect(client.options.password).toBe('secret-from-env');
  });

  it('keeps the URL-embedded password (normal prod path), does not clobber it', async (ctx) => {
    story(ctx, 'Normalna ścieżka prod: hasło wstrzyknięte w URL przez sh -c wrapper. Jawna opcja NIE może go nadpisać — ioredis preferuje hasło z URL.');
    process.env.REDIS_URL = 'redis://:url-password@clipnest-redis:6379';
    process.env.REDIS_PASSWORD = 'a-different-env-password';
    const client = getRedis({ lazyConnect: true });
    expect(client.options.password).toBe('url-password');
  });

  it('leaves password undefined when neither URL nor env carries one (local/CI)', async (ctx) => {
    story(ctx, 'Lokalnie / CI Redis jest bez hasła — brak AUTH, password undefined, połączenie działa bez NOAUTH.');
    process.env.REDIS_URL = 'redis://localhost:6379';
    delete process.env.REDIS_PASSWORD;
    const client = getRedis({ lazyConnect: true });
    // ioredis normalises an absent password to null; either falsy form means
    // "send no AUTH" — what we want for an unauthenticated local/CI Redis.
    expect(client.options.password ?? undefined).toBeUndefined();
  });

  it('propagates the resolved password to duplicated (subscriber/consumer) connections', async (ctx) => {
    story(ctx, 'streamsClient daje każdemu konsumentowi własne połączenie przez .duplicate(). Musi ono dziedziczyć hasło, inaczej blokujący XREADGROUP po reconnect dostaje NOAUTH.');
    process.env.REDIS_URL = 'redis://clipnest-redis:6379';
    process.env.REDIS_PASSWORD = 'consumer-secret';
    const client = getRedis({ lazyConnect: true });
    const dup = client.duplicate();
    try {
      expect(dup.options.password).toBe('consumer-secret');
    } finally {
      dup.disconnect();
    }
  });

  it('getRedisUrl falls back to the default service URL when REDIS_URL is unset', (ctx) => {
    story(ctx, 'Sanity dla fallbacku URL.');
    delete process.env.REDIS_URL;
    expect(getRedisUrl()).toBe('redis://redis:6379');
  });
});
