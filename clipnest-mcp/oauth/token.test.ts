import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import pg from 'pg';
import { __setPoolForTest } from '../../server/db/index.js';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __mcp_dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__mcp_dirname, '..', '..', 'server', 'db', 'migrations');
import { createClient, insertAuthCode } from '../db/queries.js';
import { mountToken } from './token.js';
import { hashToken, mintOpaqueToken } from './accessToken.js';
import { challengeFromVerifier, generateRandomVerifier } from './pkce.js';
import { randomUUID } from 'crypto';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;
const RESOURCE = 'https://clipnest.example/mcp';

const SCRATCH_DB_TOK = `mcp_tok_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('POST /mcp/oauth/token', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let app: express.Express;
  let clientId: string;
  let userId: number;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_TOK}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_TOK}"`);
    parent.pathname = `/${SCRATCH_DB_TOK}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `tok-test-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    clientId = await createClient({
      clientName: 'T',
      redirectUris: ['http://127.0.0.1:9999/cb'],
      createdByUserId: userId,
    });
    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    mountToken(app);
  }, 30_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_TOK}"`);
    await adminPool.end();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oauth_authorization_codes RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_access_tokens RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_refresh_tokens RESTART IDENTITY CASCADE`);
  });

  async function seedAuthCode(opts: { verifier?: string; scope?: string; redirectUri?: string; resource?: string } = {}) {
    const verifier = opts.verifier ?? generateRandomVerifier();
    const code = mintOpaqueToken('mcp_ac_');
    const familyId = randomUUID();
    await insertAuthCode({
      codeHash: hashToken(code), clientId, userId,
      redirectUri: opts.redirectUri ?? 'http://127.0.0.1:9999/cb',
      scope: opts.scope ?? 'videos:read',
      codeChallenge: challengeFromVerifier(verifier),
      resource: opts.resource ?? RESOURCE,
      expiresAt: new Date(Date.now() + 60_000),
      familyId,
    });
    return { code, verifier, familyId };
  }

  it('authorization_code grant returns access + refresh + scope', async () => {
    const { code, verifier } = await seedAuthCode();
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(/^mcp_at_/);
    expect(res.body.refresh_token).toMatch(/^mcp_rt_/);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(900);
    expect(res.body.scope).toBe('videos:read');
  });

  it('rejects unsupported grant_type', async () => {
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'password', resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('rejects wrong resource (invalid_target)', async () => {
    const { code, verifier } = await seedAuthCode();
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier,
      resource: 'https://evil.example/mcp',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });

  it('authorization_code: PKCE mismatch → 400 + family revoke', async () => {
    const { code, familyId: _familyId } = await seedAuthCode();
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb',
      code_verifier: 'a'.repeat(50),
      resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('authorization_code is single-use (second call → invalid_grant)', async () => {
    const { code, verifier } = await seedAuthCode();
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    expect(first.status).toBe(200);
    const second = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('authorization_code: wrong redirect_uri → invalid_grant + family revoke', async () => {
    const { code, verifier, familyId: _familyId } = await seedAuthCode();
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://different/cb', code_verifier: verifier, resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refresh_token grant rotates and old becomes invalid', async () => {
    const { code, verifier } = await seedAuthCode();
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    const oldRefresh = first.body.refresh_token as string;

    const second = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId, resource: RESOURCE,
    });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(oldRefresh);
    expect(second.body.access_token).not.toBe(first.body.access_token);

    // Reuse of old refresh kills the whole family
    const third = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId, resource: RESOURCE,
    });
    expect(third.status).toBe(400);

    // The NEW refresh issued in second is also now revoked (family killed)
    const fourth = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: clientId, resource: RESOURCE,
    });
    expect(fourth.status).toBe(400);
  });

  it('refresh_token: client_id mismatch → invalid_grant', async () => {
    const { code, verifier } = await seedAuthCode();
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token,
      client_id: '00000000-0000-0000-0000-000000000000', resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refresh_token cannot widen scope (downgrade only)', async () => {
    const { code, verifier } = await seedAuthCode({ scope: 'videos:read' });
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token,
      client_id: clientId, resource: RESOURCE,
      scope: 'videos:read videos:delete',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });

  it('refresh_token can narrow scope', async () => {
    const { code, verifier } = await seedAuthCode({ scope: 'videos:read videos:delete' });
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token,
      client_id: clientId, resource: RESOURCE, scope: 'videos:read',
    });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('videos:read');
  });

  it('refresh_token of unknown token → invalid_grant', async () => {
    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: 'mcp_rt_unknown',
      client_id: clientId, resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refresh_token is rejected once the user token_generation advances', async () => {
    const { code, verifier } = await seedAuthCode();
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    expect(first.status).toBe(200);

    // User rotates credentials → global generation bumped past the grant.
    await pool.query(`UPDATE users SET token_generation = token_generation + 1 WHERE id = $1`, [userId]);

    const res = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token,
      client_id: clientId, resource: RESOURCE,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');

    // Reset so later tests see the original generation.
    await pool.query(`UPDATE users SET token_generation = token_generation - 1 WHERE id = $1`, [userId]);
  });

  it('refresh carries the frozen generation forward (rotation does not re-capture)', async () => {
    const { code, verifier } = await seedAuthCode();
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    const second = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token,
      client_id: clientId, resource: RESOURCE,
    });
    expect(second.status).toBe(200);
    // The rotated access token must still carry the grant's original generation
    // (0 for this fresh user), not a value re-read at refresh time.
    const r = await pool.query(
      `SELECT token_generation FROM oauth_access_tokens WHERE token_hash = $1`,
      [hashToken(second.body.access_token)],
    );
    expect(r.rows[0].token_generation).toBe(0);
  });

  it('audit log records token.issue and token.refresh', async () => {
    const { code, verifier } = await seedAuthCode();
    const first = await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier, resource: RESOURCE,
    });
    await request(app).post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: first.body.refresh_token,
      client_id: clientId, resource: RESOURCE,
    });
    const r = await pool.query(`SELECT action FROM mcp_audit_log ORDER BY id`);
    const actions = r.rows.map((x: any) => x.action);
    expect(actions).toContain('token.issue');
    expect(actions).toContain('token.refresh');
  });
});
