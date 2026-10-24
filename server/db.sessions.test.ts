/**
 * Integration test: per-device sessions (`user_sessions`).
 *
 * Signing out on one device ends that device's session and leaves the others
 * signed in; bumping token_generation still ends them all.
 *
 * Real Postgres only. Set DATABASE_URL (CI does); the suite skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import {
  createSession,
  touchSession,
  revokeSession,
  getSessionAuthState,
  deleteExpiredSessions,
} from './db/queries/sessions.js';
import { bumpTokenGeneration } from './db/queries/users.js';
import { __setPoolForTest } from './db/index.js';
import { story } from './testing/story.js';

vi.setConfig({ testTimeout: 30_000 });
const HOOK_TIMEOUT = 90_000;

const TEST_URL = process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

describeIfDb('user_sessions', () => {
  const SCHEMA = `clipnest_sessions_test_${Date.now()}`;
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
    // Minimal schema — only the columns the session queries touch.
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        token_generation INTEGER NOT NULL DEFAULT 0
      )
    `);
    await client.query(`
      CREATE TABLE user_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
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
    await client.query('TRUNCATE users, user_sessions RESTART IDENTITY CASCADE');
  });

  async function seedUser(): Promise<number> {
    const u = await client.query(`INSERT INTO users (token_generation) VALUES (0) RETURNING id`);
    return u.rows[0].id as number;
  }

  it('signing out one device leaves the other signed in', async (ctx) => {
    story(ctx, 'Wylogowanie laptopa kończy tylko jego sesję — telefon tego samego konta dalej działa i dalej się odświeża.');
    const userId = await seedUser();
    const laptop = await createSession(userId);
    const phone = await createSession(userId);
    expect(laptop).not.toBe(phone);

    expect(await revokeSession(laptop, userId)).toBe(true);

    expect(await getSessionAuthState(userId, laptop)).toEqual({ tokenGeneration: 0, sessionActive: false });
    expect(await getSessionAuthState(userId, phone)).toEqual({ tokenGeneration: 0, sessionActive: true });
    expect(await touchSession(laptop, userId)).toBe(false);
    expect(await touchSession(phone, userId)).toBe(true);
    // A second sign-out of the same device is a no-op.
    expect(await revokeSession(laptop, userId)).toBe(false);
  });

  it('a session cannot be used or ended under another account', async (ctx) => {
    story(ctx, 'Identyfikator sesji jednego konta nic nie znaczy dla innego — ani jej nie odświeży, ani nie wyloguje cudzego urządzenia.');
    const alice = await seedUser();
    const bob = await seedUser();
    const aliceSession = await createSession(alice);

    expect((await getSessionAuthState(bob, aliceSession)).sessionActive).toBe(false);
    expect(await touchSession(aliceSession, bob)).toBe(false);
    expect(await revokeSession(aliceSession, bob)).toBe(false);
    expect((await getSessionAuthState(alice, aliceSession)).sessionActive).toBe(true);
  });

  it('a sign-out everywhere is visible through the generation', async (ctx) => {
    story(ctx, 'Po „wyloguj wszędzie” generacja tokenów rośnie, więc tokeny każdej sesji przestają pasować, choć wiersze sesji zostają.');
    const userId = await seedUser();
    const s = await createSession(userId);
    await bumpTokenGeneration(userId);
    expect(await getSessionAuthState(userId, s)).toEqual({ tokenGeneration: 1, sessionActive: true });
  });

  it('reports an unknown user as generation -1', async () => {
    expect(await getSessionAuthState(999, 'nope')).toEqual({ tokenGeneration: -1, sessionActive: false });
  });

  it('a refresh extends the session and the sweep deletes only expired ones', async (ctx) => {
    story(ctx, 'Sesja żyje tak długo jak refresh token: każde odświeżenie ją przedłuża, a wygasłe (także wylogowane) sprząta cykliczny sweep.');
    const userId = await seedUser();
    const live = await createSession(userId);
    const stale = await createSession(userId);
    await client.query(`UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [stale]);

    expect(await touchSession(stale, userId)).toBe(false);
    const before = (await client.query(`SELECT expires_at FROM user_sessions WHERE id=$1`, [live])).rows[0].expires_at as Date;
    await new Promise(r => setTimeout(r, 20));
    expect(await touchSession(live, userId)).toBe(true);
    const after = (await client.query(`SELECT expires_at FROM user_sessions WHERE id=$1`, [live])).rows[0].expires_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    expect(await deleteExpiredSessions()).toBe(1);
    const left = await client.query(`SELECT id FROM user_sessions`);
    expect(left.rows.map(r => r.id)).toEqual([live]);
  });
});
