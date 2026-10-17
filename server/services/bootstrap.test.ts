import { describe, it, expect, vi, beforeEach } from 'vitest';
import { story } from '../testing/story.js';

const mockCreateFirstAccount = vi.fn();
const mockGetUserCount = vi.fn();
const mockGetUserByEmail = vi.fn();
const mockUpdatePassword = vi.fn();
vi.mock('../db/queries/users.js', () => ({
  createFirstAccount: (...a: unknown[]) => mockCreateFirstAccount(...a),
  getUserCount: (...a: unknown[]) => mockGetUserCount(...a),
  getUserByEmail: (...a: unknown[]) => mockGetUserByEmail(...a),
  updateUserPasswordByInternalId: (...a: unknown[]) => mockUpdatePassword(...a),
}));
vi.mock('./auth.js', () => ({
  hashPassword: async (p: string) => `hashed:${p}`,
  verifyPassword: async (p: string, hash: string) => hash === `hashed:${p}`,
  validatePasswordStrength: (p: string) => (p.length < 8 ? 'Password too short' : null),
}));

import { bootstrapFirstAccount, seedFirstAccountFromEnv, seedOutcome, syncAccountPasswordFromEnv } from './bootstrap.js';
import { edition as selfhost } from '../editions/selfhost.js';

const OWNER = { isAdmin: false, planName: null };
const OPERATOR = { isAdmin: true, planName: 'Basic' };
// The self-hosted edition's account: only the configuration can create it.
const CONFIGURED_OWNER = { ...OWNER, fromConfig: 'set ACCOUNT_EMAIL and ACCOUNT_PASSWORD in .env' };

beforeEach(() => {
  mockCreateFirstAccount.mockReset().mockResolvedValue(true);
  mockGetUserCount.mockReset().mockResolvedValue(0);
  mockGetUserByEmail.mockReset().mockResolvedValue({ internalId: 7, passwordHash: 'hashed:Old-Passw0rd-1' });
  mockUpdatePassword.mockReset().mockResolvedValue(true);
});

describe('bootstrapFirstAccount', () => {
  it('creates the account with the role the edition asked for', async (ctx) => {
    story(ctx, 'Self-hosted zakłada jedno konto-właściciela bez planu (nielimitowane), Cloud zakłada admina na planie Basic — o roli decyduje edycja, nie instalator.');
    const r = await bootstrapFirstAccount({ email: ' Owner@Example.com ', password: 'correct horse battery' }, OWNER);
    expect(r).toEqual({ ok: true, email: 'owner@example.com' });
    expect(mockCreateFirstAccount).toHaveBeenCalledWith(expect.objectContaining({
      email: 'owner@example.com', passwordHash: 'hashed:correct horse battery', isAdmin: false, planName: null,
    }));
    const call = mockCreateFirstAccount.mock.calls[0][0];
    expect(call.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.encryptionSalt.length).toBeGreaterThan(30);

    await bootstrapFirstAccount({ email: 'admin@example.com', password: 'correct horse battery' }, OPERATOR);
    expect(mockCreateFirstAccount).toHaveBeenLastCalledWith(expect.objectContaining({ isAdmin: true, planName: 'Basic' }));
  });

  it('rejects a bad email or weak password before touching the database', async () => {
    expect((await bootstrapFirstAccount({ email: 'nope', password: 'correct horse battery' }, OWNER)).ok).toBe(false);
    expect((await bootstrapFirstAccount({ email: 'a@b.co', password: 'short' }, OWNER)).ok).toBe(false);
    expect(mockCreateFirstAccount).not.toHaveBeenCalled();
  });

  it('reports "exists" when the database is no longer empty', async (ctx) => {
    story(ctx, 'Instalator jest jednorazowy: gdy w bazie jest już konto, odmawia — to jedyna droga do pierwszego konta i nie może stać się drogą do drugiego.');
    mockCreateFirstAccount.mockResolvedValue(false);
    const r = await bootstrapFirstAccount({ email: 'a@b.co', password: 'correct horse battery' }, OWNER);
    expect(r).toMatchObject({ ok: false, reason: 'exists' });
  });
});

describe('seedFirstAccountFromEnv', () => {
  it('creates the account from CLIPNEST_BOOTSTRAP_* on first boot only', async (ctx) => {
    story(ctx, 'docker compose up z ustawionymi CLIPNEST_BOOTSTRAP_EMAIL/PASSWORD zakłada konto przy pierwszym starcie; przy kolejnych startach zmienne mogą zostać — seed jest no-opem, gdy konto istnieje.');
    const env = { CLIPNEST_BOOTSTRAP_EMAIL: 'me@example.org', CLIPNEST_BOOTSTRAP_PASSWORD: 'correct horse battery' };
    expect(await seedFirstAccountFromEnv(OWNER, env)).toBe('created');
    mockGetUserCount.mockResolvedValue(1);
    expect(await seedFirstAccountFromEnv(OWNER, env)).toBe('skipped');
    expect(mockCreateFirstAccount).toHaveBeenCalledTimes(1);
  });

  it('honours DEV_SEED_* only in development and does nothing when unset', async () => {
    const dev = { NODE_ENV: 'development', DEV_SEED_EMAIL: 'dev@example.org', DEV_SEED_PASSWORD: 'correct horse battery' };
    expect(await seedFirstAccountFromEnv(OPERATOR, dev)).toBe('created');
    expect(await seedFirstAccountFromEnv(OPERATOR, { ...dev, NODE_ENV: 'production' })).toBe('unset');
    expect(await seedFirstAccountFromEnv(OPERATOR, {})).toBe('unset');
  });

  it('keeps the development seed working with a weak password', async (ctx) => {
    story(ctx, 'Lokalne konto deweloperskie ma hasło „test" — seed z DEV_SEED_* nie przechodzi przez walidację siły hasła, w odróżnieniu od konta zakładanego przy instalacji.');
    const dev = { NODE_ENV: 'development', DEV_SEED_EMAIL: 'admin@clipnest.local', DEV_SEED_PASSWORD: 'test' };
    expect(await seedFirstAccountFromEnv(OPERATOR, dev)).toBe('created');
    expect(await seedFirstAccountFromEnv(OWNER, { CLIPNEST_BOOTSTRAP_EMAIL: 'me@example.org', CLIPNEST_BOOTSTRAP_PASSWORD: 'test' }))
      .toEqual({ failed: expect.stringContaining('too short') });
  });

  it('fails when only half of the install account is configured', async () => {
    expect(await seedFirstAccountFromEnv(OWNER, { CLIPNEST_BOOTSTRAP_EMAIL: 'me@example.org' }))
      .toEqual({ failed: expect.stringContaining('both') });
  });

  it('surfaces a validation failure instead of throwing', async () => {
    const r = await seedFirstAccountFromEnv(OWNER, { CLIPNEST_BOOTSTRAP_EMAIL: 'x', CLIPNEST_BOOTSTRAP_PASSWORD: 'correct horse battery' });
    expect(r).toEqual({ failed: expect.stringContaining('Invalid email') });
  });

  it('refuses to start an empty self-hosted install without the account settings', async (ctx) => {
    story(ctx, 'Self-hosted bez ACCOUNT_EMAIL/ACCOUNT_PASSWORD w .env i z pustą bazą nie startuje „zdrowo” z zerem kont — odmawia startu z komunikatem, co ustawić.');
    for (const env of [{}, { CLIPNEST_BOOTSTRAP_EMAIL: 'me@example.org' }, { CLIPNEST_BOOTSTRAP_PASSWORD: 'Correct-Horse-9' }]) {
      const seeded = await seedFirstAccountFromEnv(CONFIGURED_OWNER, env);
      expect(seeded).toEqual({ failed: 'set ACCOUNT_EMAIL and ACCOUNT_PASSWORD in .env' });
      const outcome = seedOutcome(seeded, CONFIGURED_OWNER);
      expect(outcome).toMatchObject({ start: false, level: 'error' });
      expect(outcome!.message).toMatch(/^Refusing to start: .*set ACCOUNT_EMAIL and ACCOUNT_PASSWORD in \.env$/);
    }
    expect(mockCreateFirstAccount).not.toHaveBeenCalled();
  });

  it('only warns when the account already exists and the settings are missing or incomplete', async (ctx) => {
    story(ctx, 'Gdy konto już istnieje, brak lub połowa ustawień konta w .env nie blokuje startu — serwer ostrzega w logu, a konto zachowuje e-mail i hasło.');
    mockGetUserCount.mockResolvedValue(1);
    for (const env of [{}, { CLIPNEST_BOOTSTRAP_EMAIL: 'me@example.org' }]) {
      const seeded = await seedFirstAccountFromEnv(CONFIGURED_OWNER, env);
      expect(seeded).toBe('missing');
      expect(seedOutcome(seeded, CONFIGURED_OWNER)).toMatchObject({
        start: true, level: 'warn', message: expect.stringContaining('ACCOUNT_EMAIL and ACCOUNT_PASSWORD'),
      });
    }
    // The same holds for an edition with other ways to get an account.
    expect(await seedFirstAccountFromEnv(OWNER, { CLIPNEST_BOOTSTRAP_EMAIL: 'me@example.org' })).toBe('missing');
  });

  it('leaves an edition that has other ways to get an account alone when nothing is set', async () => {
    expect(await seedFirstAccountFromEnv(OPERATOR, {})).toBe('unset');
    expect(seedOutcome('unset', OPERATOR)).toBeNull();
    expect(seedOutcome('skipped', CONFIGURED_OWNER)).toBeNull();
    expect(seedOutcome('created', CONFIGURED_OWNER)).toMatchObject({ start: true, level: 'log' });
    expect(mockGetUserCount).not.toHaveBeenCalled();
  });

  it('the self-hosted edition declares its account as configuration-only', () => {
    expect(selfhost.firstAccount).toEqual(CONFIGURED_OWNER);
  });
});

describe('syncAccountPasswordFromEnv', () => {
  const env = (password: string | undefined) => ({ CLIPNEST_BOOTSTRAP_EMAIL: ' Owner@Example.com ', CLIPNEST_BOOTSTRAP_PASSWORD: password });

  it('applies a changed password from the configuration', async (ctx) => {
    story(ctx, 'W self-hosted hasło konta należy do konfiguracji compose: zmiana wartości i restart wystarczą, bez żadnego ekranu w aplikacji.');
    expect(await syncAccountPasswordFromEnv(env('New-Passw0rd-22'))).toBe('updated');
    expect(mockGetUserByEmail).toHaveBeenCalledWith('owner@example.com');
    // The operator's own change: IP-wide FTP lockouts of the account are lifted too.
    expect(mockUpdatePassword).toHaveBeenCalledWith(7, 'hashed:New-Passw0rd-22', { includeIpLocks: true });
  });

  it('writes nothing when the password is already the configured one', async (ctx) => {
    story(ctx, 'Zwykły restart nie może wylogowywać — zapis hasła podbija generację tokenów, więc następuje tylko przy faktycznej zmianie.');
    expect(await syncAccountPasswordFromEnv(env('Old-Passw0rd-1'))).toBe('unchanged');
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  it('refuses a weak password, and does nothing without configuration or account', async () => {
    expect(await syncAccountPasswordFromEnv(env('short'))).toEqual({ failed: 'Password too short' });
    expect(await syncAccountPasswordFromEnv(env(undefined))).toBe('unset');
    mockGetUserByEmail.mockResolvedValue(undefined);
    expect(await syncAccountPasswordFromEnv(env('New-Passw0rd-22'))).toBe('no_account');
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });
});
