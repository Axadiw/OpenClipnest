import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { __setPoolForTest } from '../db/index.js';
import { getRedis } from '../utils/redis.js';
import { createScratchDb, type ScratchDb } from '../testing/scratch-db.js';


const TEST_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = TEST_URL ? describe : describe.skip;


describeIfDb('/api/v0/account/mcp-clients', () => {
  let pool: pg.Pool;
  let scratch: ScratchDb | undefined;
  let app: express.Express;
  let userId: number;
  let otherUserId: number;

  beforeAll(async () => {
    // No global Redis cleanup here: every test run gets a fresh userId from
    // a `randomUUID()` INSERT below, and the rate-limit bucket key is
    // `api-mcp-clients-prereg:${userId}` — collisions across runs cannot
    // happen. The rate-limit test does its own targeted `redis.del` on the
    // isolated user it creates. A wildcard `redis.keys('…:*')` here was both
    // unnecessary AND blocked the CI test-server job for 30 s waiting on
    // Redis SCAN under load.

    scratch = await createScratchDb({ max: 10 });
    pool = scratch.pool;
    __setPoolForTest(pool);

    await pool.query(
      `INSERT INTO plans (id, name, disk_space_bytes, monthly_transfer_bytes) VALUES (1, 'free', 1000000, 1000000) ON CONFLICT DO NOTHING`,
    );
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `mcli-${Date.now()}@example.com`],
    );
    userId = u.rows[0].id;
    const ou = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `mcli-other-${Date.now()}@example.com`],
    );
    otherUserId = ou.rows[0].id;

    // Targeted cleanup of our two rate-limit buckets. Each test run uses a
    // fresh PG schema, so userId/otherUserId restart at 1 — Redis buckets
    // therefore collide across runs and would leak the 20/h consumption.
    // Skip when the limiter is bypassed (CI test-server has no Redis →
    // RateLimiterMemory + this `getRedis()` would hang ioredis forever
    // because `maxRetriesPerRequest: null`).
    if (process.env.CLIPNEST_DISABLE_RATE_LIMIT !== 'true') {
      await getRedis().del(
        `api-mcp-clients-prereg:${userId}`,
        `api-mcp-clients-prereg:${otherUserId}`,
      );
    }

    const { default: mcpClientsRouter } = await import('./mcpClients.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { userId, isAdmin: false }; next(); });
    app.use('/api/v0/account/mcp-clients', mcpClientsRouter);
  }, 60_000);
  afterAll(async () => {
    await scratch?.drop();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oauth_clients RESTART IDENTITY CASCADE`);
  });

  it('POST creates client owned by current user', async () => {
    const res = await request(app).post('/api/v0/account/mcp-clients').send({
      client_name: 'My CLI', redirect_uris: ['http://127.0.0.1:9999/cb'],
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    const r = await pool.query(`SELECT created_by_user_id FROM oauth_clients WHERE client_id=$1`, [res.body.client_id]);
    expect(r.rows[0].created_by_user_id).toBe(userId);
  });

  it('POST rejects empty client_name', async () => {
    const res = await request(app).post('/api/v0/account/mcp-clients').send({
      client_name: '', redirect_uris: ['http://x'],
    });
    expect(res.status).toBe(400);
  });

  it('POST rejects empty redirect_uris', async () => {
    const res = await request(app).post('/api/v0/account/mcp-clients').send({
      client_name: 'X', redirect_uris: [],
    });
    expect(res.status).toBe(400);
  });

  it('POST rejects http:// redirect_uri to non-loopback host', async () => {
    const res = await request(app).post('/api/v0/account/mcp-clients').send({
      client_name: 'X', redirect_uris: ['http://attacker.com/cb'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('POST accepts https:// redirect_uri', async () => {
    const res = await request(app).post('/api/v0/account/mcp-clients').send({
      client_name: 'HTTPS client', redirect_uris: ['https://example.com/cb'],
    });
    expect(res.status).toBe(201);
  });

  it('POST accepts http:// loopback redirect_uri (localhost / 127.0.0.1 / [::1])', async () => {
    for (const uri of ['http://localhost:8080/cb', 'http://127.0.0.1:5173/cb', 'http://[::1]:8080/cb']) {
      const res = await request(app).post('/api/v0/account/mcp-clients').send({
        client_name: 'loopback', redirect_uris: [uri],
      });
      expect(res.status).toBe(201);
    }
  });

  // CI test-server has no Redis (server/utils/redis.ts:21 defaults to
  // `redis://redis:6379`, which doesn't resolve in the GH Actions runner)
  // and runs with CLIPNEST_DISABLE_RATE_LIMIT=true → the in-memory limiter is
  // unbounded by design. Run this assertion only when the rate limiter is
  // actually active (i.e. locally with a reachable Redis).
  const rateLimitDisabled = process.env.CLIPNEST_DISABLE_RATE_LIMIT === 'true';
  const itIfRateLimitOn = rateLimitDisabled ? it.skip : it;
  itIfRateLimitOn('POST is rate-limited per user (20/hour)', async () => {
    // Use an isolated user so the limit doesn't collide with other tests' POSTs
    // (the default test userId may have been consumed earlier in the suite).
    const u = await pool.query(
      `INSERT INTO users (uuid, email, password_hash, active, email_verified, plan_id)
       VALUES ($1, $2, 'x', true, true, 1) RETURNING id`,
      [randomUUID(), `rate-${Date.now()}@example.com`],
    );
    const isolatedUserId = u.rows[0].id;
    const isolatedApp = express();
    isolatedApp.use(express.json());
    isolatedApp.use((req, _res, next) => { (req as any).user = { userId: isolatedUserId, isAdmin: false }; next(); });
    const { default: mcpClientsRouter } = await import('./mcpClients.js');
    isolatedApp.use('/api/v0/account/mcp-clients', mcpClientsRouter);

    // Reset this user's bucket up front (defensive).
    const redis = getRedis();
    await redis.del(`api-mcp-clients-prereg:${isolatedUserId}`);

    for (let i = 0; i < 20; i++) {
      const res = await request(isolatedApp).post('/api/v0/account/mcp-clients').send({
        client_name: `cli-${i}`, redirect_uris: ['http://127.0.0.1:9999/cb'],
      });
      expect(res.status).toBe(201);
    }
    const res21 = await request(isolatedApp).post('/api/v0/account/mcp-clients').send({
      client_name: 'cli-21', redirect_uris: ['http://127.0.0.1:9999/cb'],
    });
    expect(res21.status).toBe(429);
    expect(res21.body.error).toBe('rate_limited');
    expect(res21.headers['retry-after']).toBeDefined();
  }, 60_000);

  it("GET lists clients the user has tokens for (anonymous DCR friendly)", async () => {
    // Anonymous DCR: client owned by no-one. User1 has a token for it →
    // should appear in user1's list. User2 has no token for it → invisible.
    const anonCid = randomUUID();
    const otherCid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_by_user_id) VALUES ($1,'anon-mine',ARRAY['http://x'],NULL)`, [anonCid]);
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_by_user_id) VALUES ($1,'anon-theirs',ARRAY['http://x'],NULL)`, [otherCid]);
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('a1','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min')`,
      [anonCid, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('a2','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min')`,
      [otherCid, otherUserId, randomUUID()],
    );
    const res = await request(app).get('/api/v0/account/mcp-clients');
    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: any) => c.clientName);
    expect(names).toContain('anon-mine');
    expect(names).not.toContain('anon-theirs');
  });

  it("GET sees client with only a refresh token (no access yet)", async () => {
    const cid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,'refresh-only',ARRAY['http://x'])`, [cid]);
    await pool.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('b1','hex'), $1, $2, 'videos:read', $3, NOW() + interval '30 days')`,
      [cid, userId, randomUUID()],
    );
    const res = await request(app).get('/api/v0/account/mcp-clients');
    expect(res.body.clients.map((c: any) => c.clientName)).toContain('refresh-only');
  });

  it("GET lastUsedAt is scoped to the current user's tokens", async () => {
    const cid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,'cli',ARRAY['http://x'])`, [cid]);
    // user2 has used it recently, but the response we return to user1 must
    // NOT leak user2's last_used_at.
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at, last_used_at)
       VALUES (decode('c1','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min', NOW())`,
      [cid, otherUserId, randomUUID()],
    );
    // user1 has its own token, never used
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('c2','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min')`,
      [cid, userId, randomUUID()],
    );
    const res = await request(app).get('/api/v0/account/mcp-clients');
    const c = res.body.clients.find((x: any) => x.clientName === 'cli');
    expect(c.lastUsedAt).toBeNull();
  });

  it("GET marks revokedAt when user's tokens are all revoked/expired", async () => {
    const cid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,'revoked',ARRAY['http://x'])`, [cid]);
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at, revoked_at)
       VALUES (decode('d1','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min', NOW())`,
      [cid, userId, randomUUID()],
    );
    const res = await request(app).get('/api/v0/account/mcp-clients');
    const c = res.body.clients.find((x: any) => x.clientName === 'revoked');
    expect(c).toBeDefined();
    expect(c.revokedAt).not.toBeNull();
  });

  it('GET serializes timestamps as ISO-8601, not raw Postgres format', async () => {
    // Regression: listManagedClients reads via db.execute(sql`...`) (raw SQL,
    // no Drizzle column mapping), so node-postgres handed createdAt/revokedAt/
    // lastUsedAt back as raw Postgres text — e.g. "2026-05-26 18:43:56.591823+00"
    // (space separator, 6-digit microseconds, bare +00). The route passed them
    // straight to res.json, so the API leaked that non-ISO shape. Swift's strict
    // .iso8601 decoder rejected it and the iOS AI Connections screen broke for
    // accounts that had clients. Every other
    // endpoint emits ISO-8601 via .toISOString(); this one must too.
    const cid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,'iso-check',ARRAY['http://x'])`, [cid]);
    // One revoked token that was used once exercises all three timestamp fields
    // at once: createdAt (the client row), revokedAt (CASE → NOW(), since the
    // user has no live token), lastUsedAt (MAX last_used_at over the user's tokens).
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at, last_used_at, revoked_at)
       VALUES (decode('aa','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min', NOW(), NOW())`,
      [cid, userId, randomUUID()],
    );
    const res = await request(app).get('/api/v0/account/mcp-clients');
    expect(res.status).toBe(200);
    const c = res.body.clients.find((x: any) => x.clientName === 'iso-check');
    expect(c).toBeDefined();

    // Strict ISO-8601 UTC: millisecond precision and a trailing Z — exactly what
    // Date.prototype.toISOString() produces and what a strict .iso8601 decoder
    // accepts. The raw Postgres shape (space, microseconds, "+00") fails this.
    const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const field of ['createdAt', 'revokedAt', 'lastUsedAt'] as const) {
      expect(c[field], `${field} should be present`).not.toBeNull();
      expect(c[field], `${field} should be ISO-8601`).toMatch(ISO_8601);
      // Canonical: parsing then re-emitting yields the identical string.
      expect(new Date(c[field]).toISOString()).toBe(c[field]);
    }
  });

  it("DELETE revokes only the current user's tokens — leaves oauth_clients alone", async () => {
    const cid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,'cli',ARRAY['http://x'])`, [cid]);
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('e1','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min')`,
      [cid, userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('e2','hex'), $1, $2, 'videos:read', $3, NOW() + interval '30 days')`,
      [cid, userId, randomUUID()],
    );
    // user2 also has tokens for the same client — must NOT be touched.
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('e3','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min')`,
      [cid, otherUserId, randomUUID()],
    );

    const res = await request(app).delete(`/api/v0/account/mcp-clients/${cid}`);
    expect(res.status).toBe(204);

    // user1's tokens revoked
    const myAt = await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE token_hash=decode('e1','hex')`);
    expect(myAt.rows[0].revoked_at).not.toBeNull();
    const myRt = await pool.query(`SELECT revoked_at FROM oauth_refresh_tokens WHERE token_hash=decode('e2','hex')`);
    expect(myRt.rows[0].revoked_at).not.toBeNull();

    // user2's token NOT touched
    const theirAt = await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE token_hash=decode('e3','hex')`);
    expect(theirAt.rows[0].revoked_at).toBeNull();

    // oauth_clients row itself NOT revoked (shared resource)
    const c = await pool.query(`SELECT revoked_at FROM oauth_clients WHERE client_id=$1`, [cid]);
    expect(c.rows[0].revoked_at).toBeNull();
  });

  it("DELETE returns 404 when the user has no tokens for the given client", async () => {
    const cid = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,'theirs',ARRAY['http://x'])`, [cid]);
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, scope, family_id, expires_at)
       VALUES (decode('f1','hex'), $1, $2, 'videos:read', $3, NOW() + interval '15 min')`,
      [cid, otherUserId, randomUUID()],
    );
    const res = await request(app).delete(`/api/v0/account/mcp-clients/${cid}`);
    expect(res.status).toBe(404);
  });
});
