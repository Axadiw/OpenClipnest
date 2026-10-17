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
import { createClient, insertTxn } from '../db/queries.js';
import { mountConsentCallback } from './consent-callback.js';
import { randomUUID } from 'crypto';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;
const INTERNAL_KEY = 'test-internal-key';

const SCRATCH_DB_CC = `mcp_cc_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('POST /mcp/oauth/internal/consent-callback', () => {
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
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_CC}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_CC}"`);
    parent.pathname = `/${SCRATCH_DB_CC}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `cc-test-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    clientId = await createClient({
      clientName: 'T',
      redirectUris: ['http://127.0.0.1:9999/cb'],
      createdByUserId: userId,
    });
    app = express();
    app.use(express.json());
    mountConsentCallback(app, INTERNAL_KEY);
  }, 30_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_CC}"`);
    await adminPool.end();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oauth_authorization_txns RESTART IDENTITY CASCADE`);
    await pool.query(`TRUNCATE oauth_authorization_codes RESTART IDENTITY CASCADE`);
  });

  async function seedTxn() {
    return insertTxn({
      clientId, redirectUri: 'http://127.0.0.1:9999/cb',
      scope: 'videos:read', state: 'st-abc',
      codeChallenge: 'a'.repeat(43), resource: 'https://clipnest.example/mcp',
    });
  }

  it('approve → returns redirect_url with code + state', async () => {
    const txn = await seedTxn();
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn, userId, decision: 'approve', grantedScopes: 'videos:read' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.redirect_url);
    expect(url.searchParams.get('code')).toMatch(/^mcp_ac_/);
    expect(url.searchParams.get('state')).toBe('st-abc');
    // and the auth_code row exists
    const r = await pool.query(`SELECT COUNT(*)::int n FROM oauth_authorization_codes`);
    expect(r.rows[0].n).toBe(1);
  });

  it('approve also writes audit log entry authorize.approve', async () => {
    const txn = await seedTxn();
    await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn, userId, decision: 'approve', grantedScopes: 'videos:read' });
    const r = await pool.query(`SELECT action, details_json FROM mcp_audit_log ORDER BY id DESC LIMIT 1`);
    expect(r.rows[0].action).toBe('authorize.approve');
  });

  it('deny → returns redirect_url with error=access_denied + state', async () => {
    const txn = await seedTxn();
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn, userId, decision: 'deny' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.redirect_url);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st-abc');
    expect(url.searchParams.has('code')).toBe(false);
  });

  it('rejects requests without X-Internal-Api-Key (401)', async () => {
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .send({ txn: 'x', userId, decision: 'approve' });
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong X-Internal-Api-Key (401)', async () => {
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', 'wrong-key')
      .send({ txn: 'x', userId, decision: 'approve' });
    expect(res.status).toBe(401);
  });

  it('rejects wrong-length X-Internal-Api-Key without throwing RangeError (401)', async () => {
    // Regression: naked timingSafeEqual would throw `RangeError: Input
    // buffers must have the same byte length` on mismatched lengths and
    // surface as a 500. The length pre-check must short-circuit cleanly.
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', 'short')
      .send({ txn: 'x', userId, decision: 'approve' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects same-length but wrong X-Internal-Api-Key (401)', async () => {
    // 'test-internal-key' is 17 chars — pick a same-length impostor to
    // exercise the timingSafeEqual branch (not the length pre-check).
    expect(INTERNAL_KEY.length).toBe(17);
    const sameLengthWrong = 'XXXXXXXXXXXXXXXXX';
    expect(sameLengthWrong.length).toBe(INTERNAL_KEY.length);
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', sameLengthWrong)
      .send({ txn: 'x', userId, decision: 'approve' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects requests with X-Forwarded-Host (403 internal-only)', async () => {
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .set('X-Forwarded-Host', 'clipnest.example')
      .send({ txn: 'x', userId, decision: 'approve' });
    expect(res.status).toBe(403);
  });

  it('rejects unknown txn (404)', async () => {
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn: randomUUID(), userId, decision: 'approve', grantedScopes: 'videos:read' });
    expect(res.status).toBe(404);
  });

  it('rejects bad decision (400)', async () => {
    const txn = await seedTxn();
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn, userId, decision: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('approve with grantedScopes empty after intersect → 400 invalid_scope', async () => {
    const txn = await seedTxn();
    const res = await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn, userId, decision: 'approve', grantedScopes: 'videos:delete' }); // no overlap with txn scope videos:read
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });

  it('approve narrows scope to intersection (not the broader requested)', async () => {
    // Seed a txn requesting both scopes, then approve only one
    const txn = await insertTxn({
      clientId, redirectUri: 'http://127.0.0.1:9999/cb',
      scope: 'videos:read videos:delete', state: 'st',
      codeChallenge: 'a'.repeat(43), resource: 'https://clipnest.example/mcp',
    });
    await request(app).post('/mcp/oauth/internal/consent-callback')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ txn, userId, decision: 'approve', grantedScopes: 'videos:read' });
    const r = await pool.query(`SELECT scope FROM oauth_authorization_codes ORDER BY consumed_at DESC LIMIT 1`);
    expect(r.rows[0].scope).toBe('videos:read');
  });
});
