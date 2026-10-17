/**
 * Integration test: per-source-IP credential-spray throttle.
 *
 * The per-user lockout can't stop one IP spraying passwords across MANY
 * usernames — each account only sees a few failures.
 * `recordFailedLoginByIp` counts failed FTPS auths per source IP across all
 * usernames within a rolling window and, once the threshold trips, writes an
 * IP-scoped `lockout` row in user_bans that `isIpLocked` then enforces. The
 * lockout is attached to a real user_id so it surfaces in that user's ban list
 * and is cancellable via the existing `cancelBan` (admin DELETE route).
 *
 * Real Postgres only. Set DATABASE_URL (CI does); the suite skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import {
  recordFailedLoginByIp, isIpLocked, cancelBan, listActiveBans,
  recordFailedLogin, isUserLocked,
} from './db/queries/lockout.js';
import { __setPoolForTest } from './db/index.js';
import { story } from './testing/story.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.IP_THROTTLE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

// Mirror of the production threshold in db/queries/lockout.ts (IP_FAILED_THRESHOLD).
const IP_THRESHOLD = 20;

describeIfDb('recordFailedLoginByIp — per-IP credential-spray throttle', () => {
  const SCHEMA = `clipnest_ip_throttle_test_${Date.now()}`;
  let admin: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_URL!, max: 4, connectionTimeoutMillis: 5_000 });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { client = await admin.connect(); lastErr = undefined; break; }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1_000)); }
    }
    if (lastErr) throw lastErr;

    await client!.query(`CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}", public`);

    // Minimal schema — only the columns the throttle queries touch.
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        uuid TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        lockout_count INTEGER NOT NULL DEFAULT 0,
        ftp_failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        ftp_lockout_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE user_bans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        reason TEXT,
        issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        cancelled_at TIMESTAMPTZ,
        source_ip INET,
        channel TEXT
      )
    `);
    await client.query(`
      CREATE TABLE ip_login_attempts (
        source_ip INET PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lockout_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    __setPoolForTest(admin);
    admin.on('connect', c => {
      c.query(`SET search_path TO "${SCHEMA}", public`).catch(() => { /* ignore */ });
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try { await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`); } catch { /* ignore */ }
      client.release();
    }
    if (admin) await admin.end();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await client.query('TRUNCATE users, user_bans, ip_login_attempts RESTART IDENTITY CASCADE');
  });

  const IP = '203.0.113.55';

  async function seedUsers(n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = await client.query(
        `INSERT INTO users (uuid, email) VALUES ($1, $2) RETURNING id`,
        [`u-${i}`, `user${i}@test.example`],
      );
      ids.push(r.rows[0].id as number);
    }
    return ids;
  }

  it('creates an IP-scoped lockout after the threshold of failures sprayed across usernames', async (ctx) => {
    story(ctx, 'Jeden IP rozsiewający hasła po wielu loginach zostaje zablokowany po przekroczeniu progu — mimo że żadne pojedyncze konto nie dobiło do własnego lockoutu — i blokada obejmuje CAŁY adres, niezależnie od loginu.');
    const users = await seedUsers(4);

    // Spray: 20 failures from ONE IP, rotated across 4 different valid accounts.
    for (let i = 0; i < IP_THRESHOLD; i++) {
      expect((await isIpLocked(IP)).locked).toBe(false); // not locked until the trip
      await recordFailedLoginByIp(IP, users[i % users.length]);
    }

    const lock = await isIpLocked(IP);
    expect(lock.locked).toBe(true);
    expect(lock.lockedUntil).toBeTruthy();

    // The lockout row is a real user_bans row (type 'lockout', source_ip set).
    // host() strips the inet /32 host mask so the stored address reads as a
    // bare IP (a plain source_ip::text would serialize '203.0.113.55/32').
    const rows = await client.query(
      `SELECT type, channel, host(source_ip) AS source_ip, user_id FROM user_bans WHERE source_ip = $1 AND cancelled_at IS NULL`,
      [IP],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].type).toBe('lockout');
    expect(rows.rows[0].source_ip).toBe(IP);
    // An FTP lockout of the address — never of an account, never of the web.
    expect(rows.rows[0].channel).toBe('ftp');
    for (const u of users) {
      expect((await isUserLocked(u, 'web')).locked).toBe(false);
      expect((await isUserLocked(u, 'ftp')).locked).toBe(false);
    }
  });

  it('stays below the lockout until the threshold is reached', async (ctx) => {
    story(ctx, 'Kilka-kilkanaście nieudanych prób z jednego IP (typowe dla współdzielonego NAT-a po rotacji hasła) NIE blokuje adresu — próg jest znacznie wyżej niż „garść” pomyłek, więc realny obiekt z wieloma kamerami nie zostaje odcięty.');
    const [u] = await seedUsers(1);
    for (let i = 0; i < IP_THRESHOLD - 1; i++) {
      await recordFailedLoginByIp(IP, u);
    }
    expect((await isIpLocked(IP)).locked).toBe(false);
  });

  it('surfaces the lockout in the attached user ban list and an admin cancel unblocks the IP', async (ctx) => {
    story(ctx, 'Automatyczny lockout IP jest widoczny obok banów danego konta i admin może go zdjąć jednym DELETE — anulowanie natychmiast odblokowuje adres, więc użytkownik, który tylko zapomniał hasła, wraca do gry bez czekania na wygaśnięcie.');
    const [u] = await seedUsers(1);
    for (let i = 0; i < IP_THRESHOLD; i++) {
      await recordFailedLoginByIp(IP, u);
    }
    expect((await isIpLocked(IP)).locked).toBe(true);

    const bans = await listActiveBans(u);
    const lockout = bans.find(b => b.type === 'lockout');
    expect(lockout).toBeTruthy();
    // listActiveBans normalises source_ip with host() → bare IP, no /32 mask.
    expect(lockout!.sourceIp).toBe(IP);

    // Admin cancels it via the same machinery as any other ban.
    const cancelled = await cancelBan(lockout!.id, u);
    expect(cancelled).toBe(true);

    // IP is immediately unblocked.
    expect((await isIpLocked(IP)).locked).toBe(false);
  });

  it('resets the windowed counter once the window has elapsed', async (ctx) => {
    story(ctx, 'Licznik nieudanych prób per-IP działa w oknie czasowym — po jego upływie zeruje się, więc rozproszone w czasie, sporadyczne pomyłki legalnej kamery nigdy nie skumulują się do bana.');
    const [u] = await seedUsers(1);

    // 19 failures — one short of the trip.
    for (let i = 0; i < IP_THRESHOLD - 1; i++) {
      await recordFailedLoginByIp(IP, u);
    }
    // Age the window well past the 15-minute limit.
    await client.query(
      `UPDATE ip_login_attempts SET window_started_at = NOW() - INTERVAL '20 minutes' WHERE source_ip = $1`,
      [IP],
    );

    // The next failure starts a fresh window (counter → 1), not the 20th trip.
    await recordFailedLoginByIp(IP, u);
    expect((await isIpLocked(IP)).locked).toBe(false);

    const row = await client.query(
      `SELECT failed_attempts FROM ip_login_attempts WHERE source_ip = $1`,
      [IP],
    );
    expect(row.rows[0].failed_attempts).toBe(1);
  });

  it('leaves the per-user lockout path unchanged (single account still trips its own backoff)', async (ctx) => {
    story(ctx, 'Nowy throttling per-IP nie rusza istniejącego lockoutu per-konto: 5 pomyłek na jednym loginie nadal daje krótki lockout tego konta (source_ip NULL), niezależny od progu IP.');
    const [u] = await seedUsers(1);

    // 5 FTP failures on a SINGLE account → per-account FTP lockout.
    for (let i = 0; i < 5; i++) {
      await recordFailedLogin(u, 'ftp');
    }
    const locked = await isUserLocked(u, 'ftp');
    expect(locked.locked).toBe(true);

    // That per-user lockout carries NO source_ip, so it does not block the IP.
    const perUser = await client.query(
      `SELECT source_ip, channel FROM user_bans WHERE user_id = $1 AND type = 'lockout'`,
      [u],
    );
    expect(perUser.rowCount).toBe(1);
    expect(perUser.rows[0].source_ip).toBeNull();
    expect(perUser.rows[0].channel).toBe('ftp');
    expect((await isIpLocked(IP)).locked).toBe(false);
  });
});
