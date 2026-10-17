import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { story } from '../testing/story.js';
import { parseDiskLimit, secretProblems, assertSecretsConfigured } from './installConfig.js';

// Well-formed values, generated per run: nothing here is a literal that a
// reader (or a secret scanner) could mistake for a real credential. Hex with
// a letter in front can never match the placeholder patterns.
const wellFormed = (bytes: number): string => `a${randomBytes(bytes).toString('hex')}`;
const GOOD = {
  JWT_SECRET: wellFormed(20),
  CLIPNEST_ENCRYPTION_MASTER_KEY: wellFormed(20),
  CLIPNEST_INTERNAL_API_KEY: wellFormed(20),
  CLIPNEST_S3_ACCESS_KEY: 'clipnest',
  CLIPNEST_S3_SECRET_KEY: wellFormed(12),
};

describe('operator-defined secrets', () => {
  it('accepts a fully configured install', () => {
    expect(secretProblems(GOOD)).toEqual([]);
    expect(() => assertSecretsConfigured(GOOD)).not.toThrow();
  });

  it('refuses to start on a missing, placeholder or short secret', (ctx) => {
    story(ctx, 'Sekrety definiuje operator — serwer niczego nie generuje. Gdy któryś jest pusty, został z przykładu albo jest za krótki, start jest odmawiany z listą braków, bo instalacja na kluczach skopiowanych z README to instalacja na kluczach znanych każdemu.');
    expect(secretProblems({ ...GOOD, JWT_SECRET: '' })[0]).toMatch(/JWT_SECRET is not set/);
    expect(secretProblems({ ...GOOD, CLIPNEST_ENCRYPTION_MASTER_KEY: 'CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME' })[0]).toMatch(/placeholder/);
    expect(secretProblems({ ...GOOD, CLIPNEST_INTERNAL_API_KEY: 'tooshort' })[0]).toMatch(/too short/);
    expect(() => assertSecretsConfigured({})).toThrow(/Refusing to start/);
  });

  it('accepts the internal key from the file the install generates', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ikey-'));
    try {
      const file = path.join(dir, 'internal-api-key');
      writeFileSync(file, `${wellFormed(20)}\n`);
      expect(secretProblems({ ...GOOD, CLIPNEST_INTERNAL_API_KEY: '', CLIPNEST_INTERNAL_API_KEY_FILE: file })).toEqual([]);
      writeFileSync(file, 'tooshort\n');
      expect(secretProblems({ ...GOOD, CLIPNEST_INTERNAL_API_KEY: '', CLIPNEST_INTERNAL_API_KEY_FILE: file })[0]).toMatch(/too short/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('points at the .env setting and a URL-safe generator', (ctx) => {
    story(ctx, 'Komunikat mówi, którą zmienną w .env poprawić, i podaje generator sekretów bez znaków specjalnych (`openssl rand -hex 32`) — taki sekret nie psuje ani adresu bazy, ani pliku compose.');
    expect(secretProblems({ ...GOOD, JWT_SECRET: '' })[0]).toMatch(/TOKEN_SECRET in \.env/);
    expect(secretProblems({ ...GOOD, CLIPNEST_ENCRYPTION_MASTER_KEY: '' })[0]).toMatch(/ENCRYPTION_KEY in \.env/);
    expect(() => assertSecretsConfigured({})).toThrow(/openssl rand -hex 32/);
    expect(() => assertSecretsConfigured({})).not.toThrow(/base64/);
  });
});

describe('parseDiskLimit', () => {
  it('reads human sizes and plain bytes', () => {
    expect(parseDiskLimit('500GB')).toBe(500e9);
    expect(parseDiskLimit('1.5 TB')).toBe(1.5e12);
    expect(parseDiskLimit('200GiB')).toBe(200 * 1024 ** 3);
    expect(parseDiskLimit('1048576')).toBe(1048576);
  });

  it('treats empty, 0 and "unlimited" as no limit', () => {
    for (const v of [undefined, '', '0', 'unlimited', 'none']) expect(parseDiskLimit(v)).toBeNull();
  });

  it('throws on a typo instead of silently meaning unlimited', (ctx) => {
    story(ctx, 'Literówka w limicie dysku nie może po cichu oznaczać „bez limitu" — serwer odmawia startu z czytelnym komunikatem.');
    expect(() => parseDiskLimit('500 gigs')).toThrow(/cannot parse/);
    expect(() => parseDiskLimit('-5GB')).toThrow();
  });
});
