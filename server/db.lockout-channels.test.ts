/**
 * Integration test: failed-login lockouts per login channel.
 *
 * The web sign-in ('web') and camera FTP/FTPS logins ('ftp') keep separate
 * failure counters and lockouts, so a camera retrying an outdated password can
 * never lock its owner out of the web, and the other way round. Runs on the
 * real migrated schema (a scratch database per run) — the per-IP spray throttle
 * has its own suite in db.ip-throttle.test.ts.
 *
 * Real Postgres only. Set DATABASE_URL (CI does); the suite skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordFailedLogin, isUserLocked, resetLoginAttempts, clearLoginLockouts,
  recordFailedLoginByIp, isIpLocked, isUserBanned, listActiveBans,
  lockoutSeconds, LOCKOUT_THRESHOLD, LOCKOUT_CAP_SECONDS, LOCKOUT_CAPPED_TIERS, LOCKOUT_CEILING_SECONDS,
} from './db/queries/lockout.js';
import { updateUserPasswordByInternalId, getAllUsers } from './db/queries/users.js';
import { isAccessLocked, setAccessLocked } from './db/queries/access.js';
import { syncAccountPasswordFromEnv } from './services/bootstrap.js';
import { hashPassword } from './services/auth.js';
import { resetUserBan } from './scripts/reset-user-ban.js';
import { __setPoolForTest } from './db/index.js';
import { createScratchDb, type ScratchDb } from './testing/scratch-db.js';
import { story } from './testing/story.js';

vi.setConfig({ testTimeout: 30_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describe('lockoutSeconds', () => {
  const minutes = (channel: 'web' | 'ftp', tiers: number[]) => tiers.map((t) => lockoutSeconds(channel, t) / 60);
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it('holds the first 8 lockouts of a streak at the channel cap: 60 min web, 15 min FTP', (ctx) => {
    story(ctx, 'Pierwsze 8 blokad z rzędu trwa 1, 2, 4, 8… minut, ale nie dłużej niż 60 minut (web) i 15 minut (FTP) — kamera ze starym hasłem wraca do pracy chwilę po poprawce.');
    expect(minutes('web', range(1, 8))).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(minutes('ftp', range(1, 8))).toEqual([1, 2, 4, 8, 15, 15, 15, 15]);
    expect(LOCKOUT_CAP_SECONDS).toEqual({ web: 3600, ftp: 900 });
    expect(LOCKOUT_CAPPED_TIERS).toBe(8);
    expect(LOCKOUT_THRESHOLD).toBe(5);
  });

  it('doubles again from the cap after the 8th lockout, up to 24 h', (ctx) => {
    story(ctx, 'Kto zgaduje hasło dalej, po 8. blokadzie z rzędu znów dostaje coraz dłuższe blokady — od limitu kanału aż do 24 godzin — więc zgadywanie nie może trwać w stałym tempie bez końca.');
    expect(minutes('web', range(9, 14))).toEqual([120, 240, 480, 960, 1440, 1440]);
    expect(minutes('ftp', range(9, 16))).toEqual([30, 60, 120, 240, 480, 960, 1440, 1440]);
    expect(lockoutSeconds('web', 1000)).toBe(LOCKOUT_CEILING_SECONDS);
    expect(lockoutSeconds('ftp', 1000)).toBe(LOCKOUT_CEILING_SECONDS);
    expect(LOCKOUT_CEILING_SECONDS).toBe(24 * 3600);
  });
});

describeIfDb('login lockouts per channel', () => {
  let pool: pg.Pool;
  let scratch: ScratchDb | undefined;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 5 });
    pool = scratch.pool;
    __setPoolForTest(pool);
  }, 90_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, user_bans, ip_login_attempts RESTART IDENTITY CASCADE');
  });

  async function seedUser(opts: { email?: string; passwordHash?: string } = {}): Promise<{ id: number; email: string }> {
    const email = opts.email ?? `user-${randomUUID()}@example.org`;
    const r = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, encryption_salt) VALUES ($1, $2, $3, 'salt') RETURNING id`,
      [randomUUID(), email, opts.passwordHash ?? 'x'],
    );
    return { id: r.rows[0].id as number, email };
  }

  async function fail(id: number, channel: 'web' | 'ftp', times: number): Promise<void> {
    for (let i = 0; i < times; i++) await recordFailedLogin(id, channel);
  }

  async function counters(id: number) {
    const r = await pool.query(
      `SELECT failed_login_attempts AS web, lockout_count AS "webTier",
              ftp_failed_login_attempts AS ftp, ftp_lockout_count AS "ftpTier"
         FROM users WHERE id = $1`,
      [id],
    );
    return r.rows[0] as { web: number; webTier: number; ftp: number; ftpTier: number };
  }

  /** 20 failed FTP logins from `ip` against `userId`: trips the IP-wide lockout. */
  async function spray(ip: string, userId: number): Promise<void> {
    for (let i = 0; i < 20; i++) await recordFailedLoginByIp(ip, userId);
  }

  async function ipCounter(ip: string): Promise<{ failed_attempts: number; lockout_count: number } | null> {
    const r = await pool.query('SELECT failed_attempts, lockout_count FROM ip_login_attempts WHERE source_ip = $1', [ip]);
    return r.rows[0] ?? null;
  }

  async function lastIpLockoutLength(ip: string): Promise<number> {
    const r = await pool.query(
      `SELECT EXTRACT(EPOCH FROM expires_at - created_at)::float AS s FROM user_bans
        WHERE source_ip = $1 AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1`,
      [ip],
    );
    return Math.round(r.rows[0].s as number);
  }

  /** Lockout lengths (seconds) of the account's lockout rows, oldest first. */
  async function lockoutLengths(id: number, channel: 'web' | 'ftp'): Promise<number[]> {
    const r = await pool.query(
      `SELECT EXTRACT(EPOCH FROM expires_at - created_at)::float AS s FROM user_bans
        WHERE user_id = $1 AND type = 'lockout' AND channel = $2 ORDER BY id`,
      [id, channel],
    );
    return r.rows.map((row: { s: number }) => Math.round(row.s));
  }

  it('locks only the web sign-in after 5 failed web logins', async (ctx) => {
    story(ctx, 'Pięć złych haseł w logowaniu przez web blokuje tylko logowanie przez web — kamery dalej wgrywają nagrania.');
    const u = await seedUser();
    await fail(u.id, 'web', LOCKOUT_THRESHOLD - 1);
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
    await fail(u.id, 'web', 1);
    expect((await isUserLocked(u.id, 'web')).locked).toBe(true);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
    expect(await counters(u.id)).toEqual({ web: 0, webTier: 1, ftp: 0, ftpTier: 0 });
  });

  it('locks only FTP after 5 failed camera logins — the owner can still sign in on the web', async (ctx) => {
    story(ctx, 'Kamera ze starym hasłem po pięciu nieudanych logowaniach blokuje wyłącznie logowanie FTP; właściciel nadal loguje się przez web i może naprawić konfigurację.');
    const u = await seedUser();
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(true);
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
    expect(await counters(u.id)).toEqual({ web: 0, webTier: 0, ftp: 0, ftpTier: 1 });
  });

  it('doubles successive lockouts, holds them at the cap, then escalates again after the 8th', async () => {
    const u = await seedUser();
    await fail(u.id, 'web', LOCKOUT_THRESHOLD * 3);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD * 3);
    expect(await lockoutLengths(u.id, 'web')).toEqual([60, 120, 240]);
    expect(await lockoutLengths(u.id, 'ftp')).toEqual([60, 120, 240]);

    // The 7th and 8th lockouts of the streak sit at the cap …
    await pool.query('UPDATE users SET lockout_count = 6, ftp_lockout_count = 6 WHERE id = $1', [u.id]);
    await fail(u.id, 'web', LOCKOUT_THRESHOLD * 2);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD * 2);
    expect((await lockoutLengths(u.id, 'web')).slice(-2)).toEqual([3600, 3600]);
    expect((await lockoutLengths(u.id, 'ftp')).slice(-2)).toEqual([900, 900]);

    // … the 9th doubles from the cap, and the streak tops out at 24 h.
    await fail(u.id, 'web', LOCKOUT_THRESHOLD);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
    expect((await lockoutLengths(u.id, 'web')).at(-1)).toBe(7200);
    expect((await lockoutLengths(u.id, 'ftp')).at(-1)).toBe(1800);
    await pool.query('UPDATE users SET lockout_count = 40, ftp_lockout_count = 40 WHERE id = $1', [u.id]);
    await fail(u.id, 'web', LOCKOUT_THRESHOLD);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
    expect((await lockoutLengths(u.id, 'web')).at(-1)).toBe(86400);
    expect((await lockoutLengths(u.id, 'ftp')).at(-1)).toBe(86400);
  });

  it('a success or a password change ends the streak: the next lockout is one minute again', async () => {
    const u = await seedUser();
    await pool.query('UPDATE users SET lockout_count = 12, ftp_lockout_count = 12 WHERE id = $1', [u.id]);
    await resetLoginAttempts(u.id, 'web');
    await fail(u.id, 'web', LOCKOUT_THRESHOLD);
    expect((await lockoutLengths(u.id, 'web')).at(-1)).toBe(60);
    expect((await counters(u.id)).ftpTier).toBe(12); // the other channel keeps its streak

    await updateUserPasswordByInternalId(u.id, 'another-hash');
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
    expect((await lockoutLengths(u.id, 'ftp')).at(-1)).toBe(60);
  });

  it('a success resets the counters of its own channel only', async (ctx) => {
    story(ctx, 'Udane logowanie zeruje licznik tylko swojego kanału — udane logowanie przez web nie kasuje pomyłek kamery i odwrotnie.');
    const u = await seedUser();
    await fail(u.id, 'web', 4);
    await fail(u.id, 'ftp', 4);
    await pool.query('UPDATE users SET lockout_count = 2, ftp_lockout_count = 3 WHERE id = $1', [u.id]);

    await resetLoginAttempts(u.id, 'web');
    expect(await counters(u.id)).toEqual({ web: 0, webTier: 0, ftp: 4, ftpTier: 3 });

    await fail(u.id, 'ftp', 1); // the 5th FTP failure in a row still trips
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(true);
    await fail(u.id, 'web', 1);
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);

    await resetLoginAttempts(u.id, 'ftp');
    expect(await counters(u.id)).toMatchObject({ ftp: 0, ftpTier: 0, web: 1 });
  });

  it('trips exactly one lockout per 5 failures, even when they arrive at once', async () => {
    const u = await seedUser();
    await Promise.all(Array.from({ length: LOCKOUT_THRESHOLD * 2 }, () => recordFailedLogin(u.id, 'web')));
    expect(await lockoutLengths(u.id, 'web')).toEqual([60, 120]);
    expect(await counters(u.id)).toMatchObject({ web: 0, webTier: 2 });
  });

  it('a lockout from before the split blocks both channels until it expires', async (ctx) => {
    story(ctx, 'Blokada zapisana przed rozdzieleniem kanałów (bez kanału) dalej blokuje oba logowania aż do wygaśnięcia — wdrożenie niczego nie odblokowuje przedwcześnie.');
    const u = await seedUser();
    await pool.query(
      `INSERT INTO user_bans (user_id, type, expires_at) VALUES ($1, 'lockout', NOW() + INTERVAL '5 minutes')`,
      [u.id],
    );
    expect((await isUserLocked(u.id, 'web')).locked).toBe(true);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(true);

    await pool.query(`UPDATE user_bans SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1`, [u.id]);
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
  });

  it('keeps the IP-wide spray lockout on FTP: it blocks the address, never the account or the web', async (ctx) => {
    story(ctx, 'Blokada adresu IP po rozpylaniu haseł dotyczy tylko FTP z tego adresu: nie blokuje logowania przez web i nie blokuje kamer tego konta z innych adresów.');
    const owner = await seedUser();
    const others = [await seedUser(), await seedUser()];
    const ip = '198.51.100.23';
    for (let i = 0; i < 20; i++) await recordFailedLoginByIp(ip, i === 19 ? owner.id : others[i % 2].id);

    expect((await isIpLocked(ip)).locked).toBe(true);
    for (const u of [owner, ...others]) {
      expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
      expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
    }
    const [ban] = await listActiveBans(owner.id);
    expect(ban).toMatchObject({ type: 'lockout', channel: 'ftp', sourceIp: ip });
  });

  it('a password change lifts the account lockouts of both channels, not manual bans or IP lockouts', async (ctx) => {
    story(ctx, 'Zmiana hasła zeruje liczniki i zdejmuje blokady obu kanałów (zarobione starym hasłem). Ban administratora i blokada adresu IP zostają — tę drugą zdejmuje tylko jej wygaśnięcie albo reset-user-ban.');
    const u = await seedUser();
    await fail(u.id, 'web', LOCKOUT_THRESHOLD + 2);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD + 3);
    const ip = '203.0.113.77';
    for (let i = 0; i < 20; i++) await recordFailedLoginByIp(ip, u.id);
    await pool.query(
      `INSERT INTO user_bans (user_id, type, reason, expires_at) VALUES ($1, 'manual', 'abuse', NOW() + INTERVAL '1 day')`,
      [u.id],
    );

    expect(await updateUserPasswordByInternalId(u.id, 'new-hash')).toBe(true);

    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
    expect(await counters(u.id)).toEqual({ web: 0, webTier: 0, ftp: 0, ftpTier: 0 });
    expect((await isUserBanned(u.id)).banned).toBe(true);
    expect((await isIpLocked(ip)).locked).toBe(true);
    expect(await ipCounter(ip)).toMatchObject({ lockout_count: 1 });
  });

  it('changes the password, signs out and lifts lockouts in one transaction — all or nothing', async (ctx) => {
    story(ctx, 'Zmiana hasła, unieważnienie sesji i zdjęcie blokad dzieją się w jednej transakcji: jeśli cokolwiek się nie uda, hasło zostaje stare — nigdy „hasło zmienione, a trasa zgłasza błąd” ani zmienione hasło bez wylogowania.');
    const u = await seedUser({ passwordHash: 'old-hash' });
    await fail(u.id, 'web', LOCKOUT_THRESHOLD);
    await pool.query(`CREATE OR REPLACE FUNCTION refuse_ban_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'user_bans is read-only'; END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER refuse_ban_update BEFORE UPDATE ON user_bans FOR EACH ROW EXECUTE FUNCTION refuse_ban_update()');
    try {
      await expect(updateUserPasswordByInternalId(u.id, 'new-hash')).rejects.toThrow();
    } finally {
      await pool.query('DROP TRIGGER refuse_ban_update ON user_bans');
    }
    const { rows: [row] } = await pool.query('SELECT password_hash, token_generation FROM users WHERE id = $1', [u.id]);
    expect(row).toEqual({ password_hash: 'old-hash', token_generation: 0 });
    expect((await isUserLocked(u.id, 'web')).locked).toBe(true);

    expect(await updateUserPasswordByInternalId(u.id, 'new-hash')).toBe(true);
    const { rows: [after] } = await pool.query('SELECT password_hash, token_generation FROM users WHERE id = $1', [u.id]);
    expect(after).toEqual({ password_hash: 'new-hash', token_generation: 1 });
  });

  it('a password change and reset-user-ban running at the same time do not deadlock', async () => {
    const u = await seedUser();
    for (let round = 0; round < 15; round++) {
      await fail(u.id, 'web', LOCKOUT_THRESHOLD);
      await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
      await expect(Promise.all([
        updateUserPasswordByInternalId(u.id, `hash-${round}`),
        resetUserBan(u.email),
        clearLoginLockouts(u.id),
      ])).resolves.toBeDefined();
    }
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
  });

  it('clearLoginLockouts touches only the given account', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await fail(a.id, 'web', LOCKOUT_THRESHOLD);
    await fail(b.id, 'web', LOCKOUT_THRESHOLD);
    await clearLoginLockouts(a.id);
    expect((await isUserLocked(a.id, 'web')).locked).toBe(false);
    expect((await isUserLocked(b.id, 'web')).locked).toBe(true);
  });

  it('the self-hosted password sync lifts every lockout of the account — IP-wide ones too — only when the password really changed', async (ctx) => {
    story(ctx, 'W self-hosted nowe hasło w .env i restart zdejmują wszystkie blokady konta: obu kanałów i blokady adresów IP przypięte do konta (z wyzerowanym poziomem). Zwykły restart z tym samym hasłem niczego nie zmienia — ani sesji, ani blokad.');
    const email = 'owner@example.org';
    const u = await seedUser({ email, passwordHash: await hashPassword('Old-Passw0rd-123') });
    await fail(u.id, 'web', LOCKOUT_THRESHOLD);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
    const ip = '198.51.100.80';
    await spray(ip, u.id);
    await spray(ip, u.id); // a second IP lockout in a row: 30 min, tier 2
    expect(await ipCounter(ip)).toMatchObject({ lockout_count: 2 });

    const env = (password: string) => ({ CLIPNEST_BOOTSTRAP_EMAIL: email, CLIPNEST_BOOTSTRAP_PASSWORD: password });
    expect(await syncAccountPasswordFromEnv(env('Old-Passw0rd-123'))).toBe('unchanged');
    expect((await isUserLocked(u.id, 'web')).locked).toBe(true);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(true);
    expect((await isIpLocked(ip)).locked).toBe(true);

    expect(await syncAccountPasswordFromEnv(env('New-Passw0rd-456'))).toBe('updated');
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
    expect((await isIpLocked(ip)).locked).toBe(false);
    expect(await ipCounter(ip)).toBeNull();
    // The address starts again from the first tier: a new spray locks it for 15 min.
    await spray(ip, u.id);
    expect(await lastIpLockoutLength(ip)).toBe(15 * 60);
  });

  it('reset-user-ban lifts every ban and lockout and resets both channels', async (ctx) => {
    story(ctx, 'Operator odblokowuje konto jednym poleceniem `reset-user-ban.js <email>`: znikają blokady obu kanałów, blokady IP przypięte do konta i bany, a liczniki i poziomy blokad wracają do zera.');
    const u = await seedUser();
    await fail(u.id, 'web', LOCKOUT_THRESHOLD * 2);
    await fail(u.id, 'ftp', LOCKOUT_THRESHOLD + 2);
    const ip = '192.0.2.44';
    for (let i = 0; i < 20; i++) await recordFailedLoginByIp(ip, u.id);
    await pool.query(
      `INSERT INTO user_bans (user_id, type, expires_at) VALUES ($1, 'manual', NOW() + INTERVAL '1 day')`,
      [u.id],
    );

    for (let i = 0; i < 7; i++) await recordFailedLoginByIp(ip, u.id); // a new window under way
    expect(await ipCounter(ip)).toMatchObject({ failed_attempts: 7, lockout_count: 1 });

    const r = await resetUserBan(u.email);
    expect(r).toEqual({ cancelled: 5, uuid: expect.any(String) });
    expect((await isUserLocked(u.id, 'web')).locked).toBe(false);
    expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
    expect((await isIpLocked(ip)).locked).toBe(false);
    expect((await isUserBanned(u.id)).banned).toBe(false);
    expect(await counters(u.id)).toEqual({ web: 0, webTier: 0, ftp: 0, ftpTier: 0 });
    // The address's counter and tier go too: a lifted IP lockout does not come
    // back at a higher tier (it would have been 30 min).
    expect(await ipCounter(ip)).toBeNull();
    await spray(ip, u.id);
    expect(await lastIpLockoutLength(ip)).toBe(15 * 60);
    expect(await resetUserBan('nobody@example.org')).toBeNull();
  });

  describe('reset-user-ban CLI', () => {
    const SCRIPT = join(__dirname, 'scripts', 'reset-user-ban.ts');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          DATABASE_URL: scratch!.url,
          JWT_SECRET: 'cli-test-secret-cli-test-secret-0123456789',
          RUN_MIGRATE_AT_STARTUP: 'false',
        },
      });

    it('prints the usage and exits 2 without an e-mail', () => {
      const r = run();
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Usage: node dist\/scripts\/reset-user-ban\.js <email>/);
    });

    it('exits 3 for an unknown e-mail and 0 after lifting the lockouts', async () => {
      expect(run('nobody@example.org').status).toBe(3);

      const u = await seedUser();
      await fail(u.id, 'ftp', LOCKOUT_THRESHOLD);
      const r = run(u.email);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Cleared 1 active ban\(s\)/);
      expect((await isUserLocked(u.id, 'ftp')).locked).toBe(false);
      expect(await counters(u.id)).toEqual({ web: 0, webTier: 0, ftp: 0, ftpTier: 0 });
    });
  });

  // Locked account access (users.access_locked_at) shares this schema rather
  // than migrating one of its own: every DB test file migrates a scratch
  // schema concurrently on CI, and one more pushed the slowest past their
  // hook timeouts.
  describe('account access lock', () => {
    it('a fresh account (even without a plan) is not locked', async (ctx) => {
      story(ctx, 'Nowe konto bez planu nie jest zablokowane — blokada to osobna, jawna flaga, a nie brak planu.');
      const u = await seedUser();
      expect(await isAccessLocked(u.id)).toBe(false);
    });

    it('lock then unlock round-trips and stamps the lock time', async (ctx) => {
      story(ctx, 'Admin blokuje konto, a potem je odblokowuje — flaga zapisuje moment blokady i znika po odblokowaniu.');
      const u = await seedUser();
      expect(await setAccessLocked(u.id, true)).toBe(true);
      expect(await isAccessLocked(u.id)).toBe(true);
      const { rows } = await pool.query('SELECT access_locked_at FROM users WHERE id = $1', [u.id]);
      expect(rows[0].access_locked_at).toBeInstanceOf(Date);
      expect(await setAccessLocked(u.id, false)).toBe(true);
      expect(await isAccessLocked(u.id)).toBe(false);
    });

    it('locking an already-locked account keeps the original lock time', async (ctx) => {
      story(ctx, 'Ponowna blokada nie przesuwa daty — od pierwszej blokady liczy się później 7 dni do usunięcia nagrań.');
      const u = await seedUser();
      const lockedAt = async () =>
        ((await pool.query('SELECT access_locked_at FROM users WHERE id = $1', [u.id])).rows[0].access_locked_at as Date).getTime();
      await setAccessLocked(u.id, true);
      const first = await lockedAt();
      await new Promise((r) => setTimeout(r, 20));
      await setAccessLocked(u.id, true);
      expect(await lockedAt()).toBe(first);
    });

    it('unknown user: isAccessLocked is false, setAccessLocked reports no row', async (ctx) => {
      story(ctx, 'Zapytanie o nieistniejące konto nie rzuca wyjątkiem.');
      expect(await isAccessLocked(999_999)).toBe(false);
      expect(await setAccessLocked(999_999, true)).toBe(false);
    });

    it('the admin user list reports accessLocked', async (ctx) => {
      story(ctx, 'Lista użytkowników admina pokazuje, które konta są zablokowane.');
      const u = await seedUser();
      await setAccessLocked(u.id, true);
      expect((await getAllUsers()).find((x) => x.email === u.email)?.accessLocked).toBe(true);
      await setAccessLocked(u.id, false);
      expect((await getAllUsers()).find((x) => x.email === u.email)?.accessLocked).toBe(false);
    });
  });
});
