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
import { getRedis } from '../../server/utils/redis.js';
import { rateLimitBypassEnabled } from '../../server/middleware/rateLimit.js';
import { mountRegister } from './register.js';
import { randomUUID } from 'crypto';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_REG = `mcp_reg_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('POST /mcp/oauth/register', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let userId: number;
  let app: express.Express;

  beforeAll(async () => {
    // Drop any leftover DCR rate-limit buckets from previous test runs so the
    // 20/hour cap doesn't bleed across suites. Without Redis (CI sets
    // CLIPNEST_DISABLE_RATE_LIMIT=true) the limiter is in memory: nothing to drop.
    if (!rateLimitBypassEnabled()) {
      const redis = getRedis();
      const keys = await redis.keys('mcp-dcr:*');
      if (keys.length > 0) await redis.del(...keys);
    }

    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_REG}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_REG}"`);
    parent.pathname = `/${SCRATCH_DB_REG}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `reg-test-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;

    app = express();
    app.use(express.json());
    // Test harness injects userId directly; real auth wiring lives elsewhere.
    app.use((req, _res, next) => { (req as any).userId = userId; next(); });
    mountRegister(app);
  }, 30_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_REG}"`);
    await adminPool.end();
  });

  it('returns 201 with client_id for valid public-client metadata', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'Claude Desktop',
      redirect_uris: ['http://127.0.0.1:54321/callback'],
      token_endpoint_auth_method: 'none',
      software_id: 'com.anthropic.claude-desktop',
      software_version: '1.2.3',
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.client_secret).toBeUndefined();
    expect(res.body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body.response_types).toEqual(['code']);
  });

  it('rejects missing redirect_uris', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({ client_name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('rejects non-http(s) redirect_uri schemes', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'X', redirect_uris: ['file:///etc/passwd'],
    });
    expect(res.status).toBe(400);
  });

  it('accepts https://example.com/cb redirect_uri', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'HTTPS client', redirect_uris: ['https://example.com/cb'],
    });
    expect(res.status).toBe(201);
  });

  it('accepts http://localhost:8080/cb redirect_uri (loopback)', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'localhost client', redirect_uris: ['http://localhost:8080/cb'],
    });
    expect(res.status).toBe(201);
  });

  it('accepts http://127.0.0.1:5173/cb redirect_uri (loopback)', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: '127 client', redirect_uris: ['http://127.0.0.1:5173/cb'],
    });
    expect(res.status).toBe(201);
  });

  it('accepts http://[::1]:8080/cb redirect_uri (IPv6 loopback)', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'ipv6 client', redirect_uris: ['http://[::1]:8080/cb'],
    });
    expect(res.status).toBe(201);
  });

  it('rejects http://attacker.com/cb redirect_uri (non-loopback http)', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'attacker', redirect_uris: ['http://attacker.com/cb'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('rejects ftp://example.com/cb redirect_uri', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'ftp', redirect_uris: ['ftp://example.com/cb'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('rejects missing client_name', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      redirect_uris: ['http://127.0.0.1:99/cb'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects token_endpoint_auth_method other than "none"', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'X', redirect_uris: ['http://127.0.0.1:99/cb'], token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(res.status).toBe(400);
    expect(res.body.error_description).toMatch(/token_endpoint_auth_method/);
  });

  it('allows anonymous DCR (no upstream userId) per RFC 7591 §3.1', async () => {
    const app2 = express();
    app2.use(express.json());
    mountRegister(app2);
    const res = await request(app2).post('/mcp/oauth/register').send({
      client_name: 'Anonymous CLI',
      redirect_uris: ['http://127.0.0.1:33333/cb'],
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    // The new row has created_by_user_id NULL
    const r = await pool.query(`SELECT created_by_user_id FROM oauth_clients WHERE client_id = $1`, [res.body.client_id]);
    expect(r.rows[0].created_by_user_id).toBeNull();
  });

  it('audit log marks anonymous DCR with anonymous: true', async () => {
    const app2 = express();
    app2.use(express.json());
    mountRegister(app2);
    await request(app2).post('/mcp/oauth/register').send({
      client_name: 'Anon Audit',
      redirect_uris: ['http://127.0.0.1:44444/cb'],
    });
    const r = await pool.query(
      `SELECT details_json, user_id FROM mcp_audit_log WHERE action='dcr.register' ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0].details_json.anonymous).toBe(true);
    expect(r.rows[0].user_id).toBeNull();
  });

  it('writes audit log entry with action dcr.register', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM mcp_audit_log WHERE action='dcr.register'`)).rows[0].n;
    const res = await request(app).post('/mcp/oauth/register').send({
      client_name: 'Audit Test', redirect_uris: ['http://127.0.0.1:99/cb'],
    });
    expect(res.status).toBe(201);
    const after = (await pool.query(`SELECT COUNT(*)::int n FROM mcp_audit_log WHERE action='dcr.register'`)).rows[0].n;
    expect(after).toBe(before + 1);
  });
});
