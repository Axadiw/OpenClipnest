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
import { createClient, insertAccessToken, insertRefreshToken } from '../db/queries.js';
import { mountRevoke } from './revoke.js';
import { hashToken, mintOpaqueToken } from './accessToken.js';
import { randomUUID } from 'crypto';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_RV = `mcp_rv_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('POST /mcp/oauth/revoke', () => {
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
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_RV}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_RV}"`);
    parent.pathname = `/${SCRATCH_DB_RV}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `rv-test-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    clientId = await createClient({
      clientName: 'T',
      redirectUris: ['http://127.0.0.1:9999/cb'],
      createdByUserId: userId,
    });
    app = express();
    app.use(express.urlencoded({ extended: false }));
    mountRevoke(app);
  }, 30_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_RV}"`);
    await adminPool.end();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oauth_access_tokens RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_refresh_tokens RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE mcp_audit_log RESTART IDENTITY`);
  });

  it('revokes a known access token', async () => {
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
    });
    const res = await request(app).post('/mcp/oauth/revoke').type('form').send({
      token: tok, token_type_hint: 'access_token',
    });
    expect(res.status).toBe(200);
    const r = await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE token_hash=$1`, [hashToken(tok)]);
    expect(r.rows[0].revoked_at).not.toBeNull();
  });

  it('revokes the whole family when given a refresh token', async () => {
    const familyId = randomUUID();
    const refresh = mintOpaqueToken('mcp_rt_');
    const access = mintOpaqueToken('mcp_at_');
    await insertRefreshToken({
      tokenHash: hashToken(refresh), clientId, userId, scope: 'videos:read',
      familyId, expiresAt: new Date(Date.now() + 86_400_000),
    });
    await insertAccessToken({
      tokenHash: hashToken(access), clientId, userId, scope: 'videos:read',
      familyId, expiresAt: new Date(Date.now() + 900_000),
    });
    const res = await request(app).post('/mcp/oauth/revoke').type('form').send({
      token: refresh, token_type_hint: 'refresh_token',
    });
    expect(res.status).toBe(200);
    const at = await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE token_hash=$1`, [hashToken(access)]);
    expect(at.rows[0].revoked_at).not.toBeNull();
    const rt = await pool.query(`SELECT revoked_at FROM oauth_refresh_tokens WHERE token_hash=$1`, [hashToken(refresh)]);
    expect(rt.rows[0].revoked_at).not.toBeNull();
  });

  it('treats mcp_rt_ prefix as refresh even without token_type_hint', async () => {
    const familyId = randomUUID();
    const refresh = mintOpaqueToken('mcp_rt_');
    const access = mintOpaqueToken('mcp_at_');
    await insertRefreshToken({
      tokenHash: hashToken(refresh), clientId, userId, scope: 'videos:read',
      familyId, expiresAt: new Date(Date.now() + 86_400_000),
    });
    await insertAccessToken({
      tokenHash: hashToken(access), clientId, userId, scope: 'videos:read',
      familyId, expiresAt: new Date(Date.now() + 900_000),
    });
    const res = await request(app).post('/mcp/oauth/revoke').type('form').send({ token: refresh });
    expect(res.status).toBe(200);
    const at = await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE token_hash=$1`, [hashToken(access)]);
    expect(at.rows[0].revoked_at).not.toBeNull();
  });

  it('returns 200 for unknown token (RFC 7009 §2.2 — no leak)', async () => {
    const res = await request(app).post('/mcp/oauth/revoke').type('form').send({ token: 'mcp_at_unknown' });
    expect(res.status).toBe(200);
  });

  it('returns 200 for missing token (no-op)', async () => {
    const res = await request(app).post('/mcp/oauth/revoke').type('form').send({});
    expect(res.status).toBe(200);
  });

  it('writes audit log entry for known access token revoke', async () => {
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
    });
    await request(app).post('/mcp/oauth/revoke').type('form').send({ token: tok });
    const r = await pool.query(`SELECT action, details_json FROM mcp_audit_log ORDER BY id DESC LIMIT 1`);
    expect(r.rows[0].action).toBe('token.revoke');
  });

  it('writes audit log entry with kind=family for refresh revoke', async () => {
    const refresh = mintOpaqueToken('mcp_rt_');
    await insertRefreshToken({
      tokenHash: hashToken(refresh), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000),
    });
    await request(app).post('/mcp/oauth/revoke').type('form').send({
      token: refresh, token_type_hint: 'refresh_token',
    });
    const r = await pool.query(`SELECT details_json FROM mcp_audit_log ORDER BY id DESC LIMIT 1`);
    expect(r.rows[0].details_json.kind).toBe('family');
  });
});
