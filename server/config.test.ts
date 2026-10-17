import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { parse } from 'pg-connection-string';
import { story } from './testing/story.js';
import { databaseUrlFromEnv, cleanFrameEnabledFromEnv } from './config.js';

/**
 * Every character that is unsafe in the userinfo part of a URL, plus a space.
 * Appended to a random prefix, so no password literal sits in the source.
 */
const URL_UNSAFE = ['/', '+', '=', '@', ':', '%', '?', '#', ' '].join('');

/** The punctuation a URL leaves alone (RFC 3986 unreserved). */
const URL_UNRESERVED = ['-', '_', '.', '~'].join('');

/** What the pg driver will actually connect with. */
function connectionOf(url: string) {
  const p = parse(url);
  return { user: p.user, password: p.password, host: p.host, port: p.port, database: p.database };
}

describe('databaseUrlFromEnv', () => {
  const bare = { DATABASE_URL: 'clipnest-db:5432/clipnest' };

  it('percent-encodes the credentials, so any password survives the URL', (ctx) => {
    story(ctx, 'Hasło bazy jest dowolnym napisem. Znaki /, +, =, @, :, %, ?, # i spacja nie mogą psuć adresu połączenia — wcześniej hasło z „/” (np. z `openssl rand -base64 48`) wywracało API przy starcie z „Invalid URL”.');
    const password = randomBytes(4).toString('hex') + URL_UNSAFE;
    const user = 'clip nest@site';
    const url = databaseUrlFromEnv({ ...bare, POSTGRES_USER: user, POSTGRES_PASSWORD: password });
    expect(connectionOf(url)).toEqual({ user, password, host: 'clipnest-db', port: '5432', database: 'clipnest' });
  });

  it('round-trips every base64 secret through the parser pg uses', () => {
    for (let i = 0; i < 500; i++) {
      const password = randomBytes(48).toString('base64');
      const url = databaseUrlFromEnv({ ...bare, POSTGRES_PASSWORD: password });
      expect(connectionOf(url).password).toBe(password);
    }
  });

  it('hands the decoded password to the pg client itself', () => {
    const password = randomBytes(4).toString('hex') + URL_UNSAFE;
    const client = new pg.Client({ connectionString: databaseUrlFromEnv({ ...bare, POSTGRES_PASSWORD: password }) });
    expect(client.password).toBe(password);
    expect(client.host).toBe('clipnest-db');
    expect(client.database).toBe('clipnest');
  });

  it('leaves a URL-safe password exactly as it was', (ctx) => {
    story(ctx, 'Hasło złożone z bezpiecznych znaków (np. z `openssl rand -hex 32`) daje dokładnie ten sam adres co dotąd — działające instalacje niczego nie zauważą.');
    const password = randomBytes(32).toString('hex');
    expect(databaseUrlFromEnv({ DATABASE_URL: 'db.internal:6432/app', POSTGRES_USER: 'app_user', POSTGRES_PASSWORD: password }))
      .toBe(`postgresql://app_user:${password}@db.internal:6432/app`);
    // The URL's unreserved punctuation must pass through untouched too.
    const unreserved = randomBytes(4).toString('hex') + URL_UNRESERVED;
    expect(databaseUrlFromEnv({ ...bare, POSTGRES_PASSWORD: unreserved }))
      .toBe(`postgresql://clipnest:${unreserved}@clipnest-db:5432/clipnest`);
  });

  it('uses a full DATABASE_URL as is', () => {
    const full = 'postgresql://u:already%2Fencoded@h:5432/d';
    expect(databaseUrlFromEnv({ DATABASE_URL: full, POSTGRES_PASSWORD: 'ignored' })).toBe(full);
    expect(databaseUrlFromEnv({ DATABASE_URL: 'postgres://u:p@h/d' })).toBe('postgres://u:p@h/d');
  });

  it('falls back to the development defaults', () => {
    expect(databaseUrlFromEnv({})).toBe('postgresql://clipnest:devpassword@clipnest-db:5432/clipnest');
  });
});

describe('cleanFrameEnabledFromEnv', () => {
  it('is on unless explicitly turned off', (ctx) => {
    story(ctx, 'Strumień `?fmt=clean` jest domyślnie włączony — instalacja, która nie ustawi zmiennej, dostaje to samo co klienci natywni oczekują; wyłącza go wyłącznie dosłowne "false".');
    expect(cleanFrameEnabledFromEnv({})).toBe(true);
    expect(cleanFrameEnabledFromEnv({ CLIPNEST_CLEAN_FRAME_ENABLED: 'true' })).toBe(true);
    expect(cleanFrameEnabledFromEnv({ CLIPNEST_CLEAN_FRAME_ENABLED: '' })).toBe(true);
    expect(cleanFrameEnabledFromEnv({ CLIPNEST_CLEAN_FRAME_ENABLED: 'false' })).toBe(false);
  });
});
