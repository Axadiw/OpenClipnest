import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../db/index.js';
import { runOauthSweep } from './oauthSweep.js';
import { createScratchDb, type ScratchDb } from '../testing/scratch-db.js';


const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;


describeIfDb('runOauthSweep', () => {
  let pool: pg.Pool;
  let scratch: ScratchDb | undefined;
  let userId: number;
  let clientId: string;

  beforeAll(async () => {
    scratch = await createScratchDb({ max: 5 });
    pool = scratch.pool;
    __setPoolForTest(pool);
    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`,
    );
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `sweep-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    clientId = randomUUID();
    await pool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_by_user_id)
       VALUES ($1, 'sweep-cli', ARRAY['http://x'], $2)`,
      [clientId, userId],
    );
  }, 60_000);
  afterAll(async () => {
    await scratch?.drop();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oauth_authorization_txns, oauth_authorization_codes, oauth_access_tokens, oauth_refresh_tokens, mcp_audit_log, tv_device_codes, user_sessions RESTART IDENTITY CASCADE`);
  });

  it('deletes txns older than 15 minutes; keeps fresh ones', async () => {
    // 16 min — past the 15-min sweep window
    await pool.query(`INSERT INTO oauth_authorization_txns (txn_id, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, created_at) VALUES ($1, $2, 'r', 'videos:read', 's', 'cc', 'S256', 'r', NOW() - interval '16 minutes')`, [randomUUID(), clientId]);
    // 5 min — still within sweep window AND still within 10-min TTL
    await pool.query(`INSERT INTO oauth_authorization_txns (txn_id, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, created_at) VALUES ($1, $2, 'r', 'videos:read', 's', 'cc', 'S256', 'r', NOW())`, [randomUUID(), clientId]);
    const c = await runOauthSweep();
    expect(c.txns).toBe(1);
    const r = await pool.query(`SELECT COUNT(*)::int n FROM oauth_authorization_txns`);
    expect(r.rows[0].n).toBe(1);
  });

  it('deletes expired auth codes (older than 5 min past expiry)', async () => {
    await pool.query(
      `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, resource, expires_at, family_id)
       VALUES (decode('aa','hex'), $1, $2, 'r', 's', 'cc', 'r', NOW() - interval '10 minutes', $3)`,
      [clientId, userId, randomUUID()],
    );
    const c = await runOauthSweep();
    expect(c.codes).toBe(1);
  });

  it('deletes expired access + refresh tokens (older than 1 hour past expiry)', async () => {
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('bb','hex'), $1, $2, 's', $3, NOW() - interval '2 hours')`,
      [clientId, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('cc','hex'), $1, $2, 's', $3, NOW() - interval '2 hours')`,
      [clientId, userId, randomUUID()],
    );
    const c = await runOauthSweep();
    expect(c.access).toBe(1);
    expect(c.refresh).toBe(1);
  });

  it('deletes audit log entries older than 90 days', async () => {
    await pool.query(`INSERT INTO mcp_audit_log (ts, action, details_json) VALUES (NOW() - interval '91 days', 'token.issue', '{}'::jsonb)`);
    await pool.query(`INSERT INTO mcp_audit_log (ts, action, details_json) VALUES (NOW(), 'token.issue', '{}'::jsonb)`);
    const c = await runOauthSweep();
    expect(c.audit).toBe(1);
    const r = await pool.query(`SELECT COUNT(*)::int n FROM mcp_audit_log`);
    expect(r.rows[0].n).toBe(1);
  });

  it('deletes lapsed Apple-TV device codes; keeps unexpired ones', async () => {
    // Lapsed 10 minutes ago — past its 5-min life.
    await pool.query(
      `INSERT INTO tv_device_codes (user_code, device_code, status, expires_at)
       VALUES ('EXPIRED1', $1, 'pending', NOW() - interval '10 minutes')`,
      [randomUUID()],
    );
    // Still live.
    await pool.query(
      `INSERT INTO tv_device_codes (user_code, device_code, status, expires_at)
       VALUES ('FRESH123', $1, 'pending', NOW() + interval '5 minutes')`,
      [randomUUID()],
    );
    const c = await runOauthSweep();
    expect(c.tvDeviceCodes).toBe(1);
    const r = await pool.query(`SELECT COUNT(*)::int n FROM tv_device_codes`);
    expect(r.rows[0].n).toBe(1);
  });

  it('deletes device sessions whose refresh token has expired; keeps live ones', async () => {
    await pool.query(
      `INSERT INTO user_sessions (id, user_id, expires_at, revoked_at)
       VALUES ('sid-expired', $1, NOW() - interval '1 minute', NOW() - interval '2 days'),
              ('sid-live', $1, NOW() + interval '29 days', NULL)`,
      [userId],
    );
    const c = await runOauthSweep();
    expect(c.sessions).toBe(1);
    const r = await pool.query(`SELECT id FROM user_sessions`);
    expect(r.rows.map(x => x.id)).toEqual(['sid-live']);
  });

  it('returns all-zero counts when there is nothing to sweep', async () => {
    const c = await runOauthSweep();
    expect(c).toEqual({ txns: 0, codes: 0, access: 0, refresh: 0, audit: 0, tvDeviceCodes: 0, sessions: 0 });
  });
});
