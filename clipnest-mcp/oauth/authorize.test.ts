import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { createClient } from '../db/queries.js';
import { mountAuthorize } from './authorize.js';
import { randomUUID } from 'crypto';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_AUTH = `mcp_auth_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('GET /mcp/oauth/authorize', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let clientId: string;
  let app: express.Express;
  const REDIRECT = 'http://127.0.0.1:9999/cb';
  const CHALLENGE = 'a'.repeat(43);
  const RESOURCE = 'https://clipnest.example/mcp';

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_AUTH}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_AUTH}"`);
    parent.pathname = `/${SCRATCH_DB_AUTH}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `auth-test-${Date.now()}@example.com`],
    );
    clientId = await createClient({
      clientName: 'T',
      redirectUris: [REDIRECT],
      createdByUserId: u.rows[0].id,
    });
    app = express();
    mountAuthorize(app);
  }, 30_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_AUTH}"`);
    await adminPool.end();
  });

  const baseQuery = () => ({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'abc',
    scope: 'videos:read',
    resource: RESOURCE,
  });

  it('302s to /oauth/consent?txn= for valid params', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query(baseQuery());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location, 'https://clipnest.example');
    expect(loc.pathname).toBe('/oauth/consent');
    expect(loc.searchParams.get('txn')).toMatch(/^[0-9a-f-]{36}$/);
    // verify the txn row was actually inserted
    const r = await pool.query(`SELECT scope, state, code_challenge, resource FROM oauth_authorization_txns WHERE txn_id=$1`,
      [loc.searchParams.get('txn')]);
    expect(r.rows[0]).toMatchObject({ scope: 'videos:read', state: 'abc', code_challenge: CHALLENGE, resource: RESOURCE });
  });

  it('rejects response_type other than "code"', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), response_type: 'token' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_response_type');
  });

  it('rejects unknown client_id', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), client_id: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects mismatched redirect_uri (exact match only)', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), redirect_uri: REDIRECT + '/extra' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects code_challenge_method=plain', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), code_challenge_method: 'plain' });
    expect(res.status).toBe(400);
  });

  it('rejects too-short code_challenge', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), code_challenge: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects missing resource parameter (RFC 8707)', async () => {
    const q = baseQuery() as any;
    delete q.resource;
    const res = await request(app).get('/mcp/oauth/authorize').query(q);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });

  it('rejects wrong resource value', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), resource: 'https://evil.example.com/mcp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });

  it('rejects unknown scope', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({ ...baseQuery(), scope: 'videos:read admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });

  it('rejects missing state', async () => {
    const q = baseQuery() as any;
    delete q.state;
    const res = await request(app).get('/mcp/oauth/authorize').query(q);
    expect(res.status).toBe(400);
  });
});
