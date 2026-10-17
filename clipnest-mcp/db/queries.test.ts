import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../../server/db/index.js';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'server', 'db', 'migrations');
import {
  createClient, getClient,
  insertTxn, claimTxn,
  insertAuthCode, claimAuthCodeAtomic,
  insertAccessToken, getAccessTokenByHash,
  insertRefreshToken, rotateRefreshAtomic, revokeRefreshFamily,
  writeAuditLog,
} from './queries.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB = `mcp_q_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('oauth queries', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    parent.pathname = `/${SCRATCH_DB}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `queries-test-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await adminPool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE oauth_clients RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_authorization_txns RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_authorization_codes RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_access_tokens RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_refresh_tokens RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE mcp_audit_log RESTART IDENTITY`);
  });

  it('createClient + getClient round-trip', async () => {
    const id = await createClient({
      clientName: 'Test',
      redirectUris: ['http://localhost:99/cb'],
      softwareId: 'x',
      softwareVersion: '1',
      createdByUserId: userId,
    });
    const c = await getClient(id);
    expect(c?.clientName).toBe('Test');
    expect(c?.redirectUris).toEqual(['http://localhost:99/cb']);
    expect(c?.createdByUserId).toBe(userId);
    expect(c?.revokedAt).toBeNull();
  });

  it('claimAuthCodeAtomic returns the row exactly once', async () => {
    const clientId = await createClient({ clientName: 'X', redirectUris: ['http://x'], createdByUserId: userId });
    const code = Buffer.from('abc');
    await insertAuthCode({
      codeHash: code, clientId, userId, redirectUri: 'http://x',
      scope: 'videos:read', codeChallenge: 'cc', resource: 'r',
      expiresAt: new Date(Date.now() + 60_000), familyId: randomUUID(),
    });
    const first = await claimAuthCodeAtomic(code);
    expect(first).not.toBeNull();
    expect(first.scope).toBe('videos:read');
    const second = await claimAuthCodeAtomic(code);
    expect(second).toBeNull();
  });

  it('claimAuthCodeAtomic rejects expired codes', async () => {
    const clientId = await createClient({ clientName: 'X', redirectUris: ['http://x'], createdByUserId: userId });
    const code = Buffer.from('expired');
    await insertAuthCode({
      codeHash: code, clientId, userId, redirectUri: 'http://x',
      scope: 'videos:read', codeChallenge: 'cc', resource: 'r',
      expiresAt: new Date(Date.now() - 1_000), familyId: randomUUID(),
    });
    expect(await claimAuthCodeAtomic(code)).toBeNull();
  });

  it('rotateRefreshAtomic: rotated then reused triggers family-revoke (caller does the revoke)', async () => {
    const clientId = await createClient({ clientName: 'T', redirectUris: ['http://x'], createdByUserId: userId });
    const familyId = randomUUID();
    const oldHash = Buffer.from('old');
    const newHash = Buffer.from('new');
    await insertRefreshToken({
      tokenHash: oldHash, clientId, userId, scope: 'videos:read', familyId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(await rotateRefreshAtomic(oldHash, newHash)).toBe('rotated');
    // attempt 2 on same old token → reused
    expect(await rotateRefreshAtomic(oldHash, Buffer.from('newer'))).toBe('reused');
    // verify rotated_to was set
    const r = await pool.query(`SELECT rotated_to FROM oauth_refresh_tokens WHERE token_hash=$1`, [oldHash]);
    expect(Buffer.from(r.rows[0].rotated_to).equals(newHash)).toBe(true);
  });

  it('rotateRefreshAtomic returns "unknown" for missing hash', async () => {
    expect(await rotateRefreshAtomic(Buffer.from('missing'), Buffer.from('new'))).toBe('unknown');
  });

  it('revokeRefreshFamily revokes both refresh + access tokens in that family', async () => {
    const clientId = await createClient({ clientName: 'T', redirectUris: ['http://x'], createdByUserId: userId });
    const familyId = randomUUID();
    await insertAccessToken({ tokenHash: Buffer.from('at1'), clientId, userId, scope: 'videos:read', familyId, expiresAt: new Date(Date.now() + 900_000) });
    await insertRefreshToken({ tokenHash: Buffer.from('rt1'), clientId, userId, scope: 'videos:read', familyId, expiresAt: new Date(Date.now() + 86_400_000) });
    await revokeRefreshFamily(familyId);
    const at = await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE family_id=$1`, [familyId]);
    expect(at.rows[0].revoked_at).not.toBeNull();
    const rt = await pool.query(`SELECT revoked_at FROM oauth_refresh_tokens WHERE family_id=$1`, [familyId]);
    expect(rt.rows[0].revoked_at).not.toBeNull();
  });

  it('getAccessTokenByHash updates last_used_at as a side-effect', async () => {
    const clientId = await createClient({ clientName: 'T', redirectUris: ['http://x'], createdByUserId: userId });
    const h = Buffer.from('attok');
    await insertAccessToken({ tokenHash: h, clientId, userId, scope: 'videos:read', familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000) });
    const r1 = await getAccessTokenByHash(h);
    expect(r1.lastUsedAt).toBeNull(); // returned row is pre-update snapshot OR post-update; check DB independently
    // re-read independently to be sure
    const direct = await pool.query(`SELECT last_used_at FROM oauth_access_tokens WHERE token_hash=$1`, [h]);
    expect(direct.rows[0].last_used_at).not.toBeNull();
  });

  it('claimTxn rejects txns older than 10 minutes', async () => {
    const clientId = await createClient({ clientName: 'T', redirectUris: ['http://x'], createdByUserId: userId });
    const txnId = await insertTxn({ clientId, redirectUri: 'http://x', scope: 'videos:read', state: 'st', codeChallenge: 'cc', resource: 'r' });
    // back-date the txn directly
    await pool.query(`UPDATE oauth_authorization_txns SET created_at = NOW() - interval '11 minutes' WHERE txn_id = $1`, [txnId]);
    expect(await claimTxn(txnId, userId, 'videos:read')).toBeNull();
  });

  it('claimTxn happy path returns full row', async () => {
    const clientId = await createClient({ clientName: 'T', redirectUris: ['http://x'], createdByUserId: userId });
    const txnId = await insertTxn({ clientId, redirectUri: 'http://x', scope: 'videos:read', state: 'st', codeChallenge: 'cc', resource: 'r' });
    const claimed = await claimTxn(txnId, userId, 'videos:read');
    expect(claimed).not.toBeNull();
    expect(claimed.userId).toBe(userId);
    expect(claimed.consumedAt).not.toBeNull();
  });

  it('writeAuditLog persists the row with JSONB payload', async () => {
    await writeAuditLog({ userId, clientId: null, action: 'token.issue', detailsJson: { foo: 'bar' }, ip: '127.0.0.1' });
    const r = await pool.query(`SELECT action, details_json, ip::text FROM mcp_audit_log ORDER BY id DESC LIMIT 1`);
    expect(r.rows[0].action).toBe('token.issue');
    expect(r.rows[0].details_json).toEqual({ foo: 'bar' });
    expect(r.rows[0].ip).toBe('127.0.0.1/32');
  });
});
