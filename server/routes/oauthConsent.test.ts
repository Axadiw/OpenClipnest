import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import pg, { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../db/index.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { migrateToSchema } from '../testing/migrate-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

vi.mock('../config.js', async () => {
  const real = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...real,
    CONFIG: { ...real.CONFIG, internalMcpUrl: 'http://mocked-mcp', internalApiKey: 'test-key' },
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const SCRATCH_SCHEMA = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('API broker /api/v0/oauth/consent/:txn', () => {
  let pool: pg.Pool;
  let app: express.Express;
  let userId: number;
  let clientId: string;
  let txnId: string;

  beforeAll(async () => {
    // options sets search_path at connection startup — no connect-event handler needed.
    pool = new Pool({ connectionString: TEST_URL, max: 5, options: `-c search_path="${SCRATCH_SCHEMA}",public` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCRATCH_SCHEMA}"`);
    await migrateToSchema(pool, SCRATCH_SCHEMA, MIGRATIONS_DIR);
    __setPoolForTest(pool);

    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`,
    );
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `api-consent-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    clientId = randomUUID();
    await pool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_by_user_id)
       VALUES ($1, 'Claude Desktop', ARRAY['http://127.0.0.1:9999/cb'], $2)`,
      [clientId, userId],
    );
    txnId = randomUUID();
    await pool.query(
      `INSERT INTO oauth_authorization_txns (txn_id, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource)
       VALUES ($1, $2, 'http://127.0.0.1:9999/cb', 'videos:read', 'st-1', 'cc', 'S256', 'https://clipnest.video/mcp')`,
      [txnId, clientId],
    );

    const { default: oauthConsentRouter } = await import('./oauthConsent.js');
    app = express();
    app.use(express.json());
    // Inject req.user (mirror real requireAuth output)
    app.use((req, _res, next) => { (req as any).user = { userId, isAdmin: false }; next(); });
    app.use('/api/v0/oauth/consent', oauthConsentRouter);
  }, 60_000);
  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    // Cleanup via a separate one-shot connection (pool's connect handler
    // would still try to SET search_path to a dropped schema otherwise).
    const cleanup = new Pool({ connectionString: TEST_URL, max: 1 });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await cleanup.end();
  });
  beforeEach(() => { fetchMock.mockReset(); });

  it('GET returns client_name + scopes + redirect_uri for a fresh txn', async () => {
    const res = await request(app).get(`/api/v0/oauth/consent/${txnId}`);
    expect(res.status).toBe(200);
    expect(res.body.clientName).toBe('Claude Desktop');
    expect(res.body.scopes).toEqual(['videos:read']);
    expect(res.body.redirectUri).toBe('http://127.0.0.1:9999/cb');
  });

  it('GET returns 404 for unknown txn', async () => {
    const res = await request(app).get(`/api/v0/oauth/consent/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('GET returns 404 for expired txn', async () => {
    const oldId = randomUUID();
    await pool.query(
      `INSERT INTO oauth_authorization_txns (txn_id, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, created_at)
       VALUES ($1, $2, 'http://x', 'videos:read', 'st', 'cc', 'S256', 'r', NOW() - interval '11 minutes')`,
      [oldId, clientId],
    );
    const res = await request(app).get(`/api/v0/oauth/consent/${oldId}`);
    expect(res.status).toBe(404);
  });

  it('POST approve forwards to MCP with internal key', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ redirect_url: 'http://127.0.0.1:9999/cb?code=mcp_ac_xyz&state=st-1' }),
    });
    const res = await request(app)
      .post(`/api/v0/oauth/consent/${txnId}`)
      .send({ decision: 'approve', scopes: ['videos:read'] });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toContain('code=mcp_ac_xyz');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mocked-mcp/mcp/oauth/internal/consent-callback',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Internal-Api-Key': 'test-key' }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.userId).toBe(userId);
    expect(body.decision).toBe('approve');
    expect(body.grantedScopes).toBe('videos:read');
  });

  it('POST deny forwards to MCP', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ redirect_url: 'http://127.0.0.1:9999/cb?error=access_denied&state=st-1' }),
    });
    const res = await request(app)
      .post(`/api/v0/oauth/consent/${txnId}`)
      .send({ decision: 'deny' });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toContain('error=access_denied');
  });

  it('POST rejects unknown decision', async () => {
    const res = await request(app)
      .post(`/api/v0/oauth/consent/${txnId}`)
      .send({ decision: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('POST returns 502 when MCP callback fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await request(app)
      .post(`/api/v0/oauth/consent/${txnId}`)
      .send({ decision: 'approve', scopes: ['videos:read'] });
    expect(res.status).toBe(502);
  });
});
