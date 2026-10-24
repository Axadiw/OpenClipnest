import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../../server/db/index.js';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __mcp_dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__mcp_dirname, '..', '..', 'server', 'db', 'migrations');
import { createClient, insertAccessToken } from '../db/queries.js';
import { hashToken, mintOpaqueToken } from '../oauth/accessToken.js';
import { bearerAuthMcp } from './bearerAuth.js';
import { story } from '../../server/testing/story.js';

const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;

const SCRATCH_DB_BA = `mcp_ba_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describeIfDb('bearerAuthMcp middleware', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let app: express.Express;
  let userId: number;
  let clientId: string;

  beforeAll(async () => {
    const parent = new URL(TEST_URL!);
    adminPool = new pg.Pool({
      connectionString: `${parent.protocol}//${parent.username}:${parent.password}@${parent.host}/postgres`,
      max: 2,
    });
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_BA}"`);
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DB_BA}"`);
    parent.pathname = `/${SCRATCH_DB_BA}`;
    pool = new pg.Pool({ connectionString: parent.toString(), max: 5 });
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    __setPoolForTest(pool);
    await pool.query(`INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`);
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `ba-test-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    clientId = await createClient({ clientName: 'T', redirectUris: ['http://x'], createdByUserId: userId });

    app = express();
    app.use('/mcp', bearerAuthMcp);
    app.use('/mcp', (req, res) => res.json({ auth: (req as any).mcpAuth, tokenForLimit: (req as any).tokenForLimit }));
  }, 30_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB_BA}"`);
    await adminPool.end();
  });

  it('rejects request without Authorization → 401 with PRM-bound WWW-Authenticate', async () => {
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer error="invalid_token"/);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=.*oauth-protected-resource/);
  });

  it('rejects malformed Bearer (not mcp_at_)', async () => {
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer garbage').send({});
    expect(res.status).toBe(401);
  });

  it('rejects unknown mcp_at_ token', async () => {
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer mcp_at_doesnotexist').send({});
    expect(res.status).toBe(401);
  });

  it('rejects expired token', async () => {
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${tok}`).send({});
    expect(res.status).toBe(401);
  });

  it('rejects revoked token', async () => {
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
    });
    await pool.query(`UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE token_hash = $1`, [hashToken(tok)]);
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${tok}`).send({});
    expect(res.status).toBe(401);
  });

  it('accepts valid token + populates req.mcpAuth and req.tokenForLimit', async () => {
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
    });
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${tok}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.auth.userId).toBe(userId);
    expect(res.body.auth.scope).toBe('videos:read');
    expect(res.body.auth.clientId).toBe(clientId);
    expect(res.body.tokenForLimit).toMatch(/^[0-9a-f]{16}$/);
  });

  // ---- token_generation (global-revocation) checks -----------------------
  // The main app bumps users.token_generation on password change / passkey
  // removal / logout / account deletion. A token whose grant was issued at an
  // older generation must be rejected even though it is neither individually
  // revoked nor expired.

  // Fresh user so bumping its generation cannot contaminate the shared user
  // used by the tests above.
  async function freshUserAtGeneration(gen: number): Promise<number> {
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id, token_generation)
       VALUES ($1, $2, 'x', true, true, 1, $3) RETURNING id`,
      [randomUUID(), `ba-gen-${randomUUID()}@example.com`, gen],
    );
    return u.rows[0].id as number;
  }

  it('accepts a token whose generation matches the user current generation', async () => {
    const genUserId = await freshUserAtGeneration(3);
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId: genUserId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
      tokenGeneration: 3,
    });
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${tok}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.auth.userId).toBe(genUserId);
  });

  it('rejects a token after the user token_generation advances past issuance', async () => {
    const genUserId = await freshUserAtGeneration(3);
    const tok = mintOpaqueToken('mcp_at_');
    // Grant issued at generation 3 — not expired, not revoked.
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId: genUserId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
      tokenGeneration: 3,
    });
    // User rotates credentials → generation bumped to 4.
    await pool.query(`UPDATE users SET token_generation = token_generation + 1 WHERE id = $1`, [genUserId]);

    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${tok}`).send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/error="invalid_token"/);
  });

  it('rejects a valid token of a locked account with 403 account_locked', async (ctx) => {
    story(ctx, 'Zablokowane konto nie korzysta z Claude/MCP: ważny token dostaje 403, bez nagłówka, który kazałby klientowi logować się od nowa.');
    const tok = mintOpaqueToken('mcp_at_');
    await insertAccessToken({
      tokenHash: hashToken(tok), clientId, userId, scope: 'videos:read',
      familyId: randomUUID(), expiresAt: new Date(Date.now() + 900_000),
    });
    await pool.query('UPDATE users SET access_locked_at = NOW() WHERE id = $1', [userId]);
    try {
      const res = await request(app).post('/mcp').set('Authorization', `Bearer ${tok}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('account_locked');
      expect(res.headers['www-authenticate']).toBeUndefined();
    } finally {
      await pool.query('UPDATE users SET access_locked_at = NULL WHERE id = $1', [userId]);
    }
  });
});
