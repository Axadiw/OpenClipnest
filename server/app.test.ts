/**
 * The self-hosted edition: the core surface is mounted and nothing else.
 * (The commercial repository additionally compares both editions side by
 * side in server/cloud/edition.test.ts.)
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Sanctioned CI/e2e bypass (refused under NODE_ENV=production) — the route
// table is what's under test here, not the per-IP buckets.
process.env.CLIPNEST_DISABLE_RATE_LIMIT = 'true';

vi.mock('./utils/redis.js', () => ({
  getRedis: () => ({ ping: async () => 'PONG' }),
}));
vi.mock('./db/index.js', () => ({
  db: {},
  pool: { query: vi.fn() },
  withTx: vi.fn(),
  withUserLock: vi.fn(),
  initDb: vi.fn(),
  pingDb: vi.fn(async () => undefined),
}));
vi.mock('./utils/socketPoolWedge.js', () => ({
  socketPoolHealthCheck: () => ({ ok: true }),
}));

const { createApp } = await import('./app.js');
const { edition } = await import('./editions/selfhost.js');
const app = createApp(edition);

describe('self-hosted edition', () => {
  it('serves the core surface', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
    expect((await request(app).get('/api/v0/healthz')).status).toBe(200);
    // Auth required (401), not unknown (404): the route is mounted.
    for (const path of ['/api/v0/events', '/api/v0/settings', '/api/v0/notifications', '/api/v0/usage',
      '/api/v0/account/mcp-clients', '/api/v0/users/me/processing-status']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/v0/auth/refresh').send({})).status).not.toBe(404);
  });

  it('describes itself in /api/v0/config', async () => {
    const res = await request(app).get('/api/v0/config');
    expect(res.status).toBe(200);
    expect(res.body.edition).toBe('selfhost');
    expect(res.body.features).toMatchObject({ registration: false, passkeys: false, oauthGoogle: false, oauthApple: false, mcp: true, paidPlans: false });
  });

  it('answers the apps\' sign-in pre-flight with password mode', async () => {
    const res = await request(app).post('/api/v0/auth/login/begin').send({ email: 'owner@example.org' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'password', oauthProviders: [] });
  });

  it('has no registration, account management, sign-in extras or metrics endpoint', async () => {
    const absent = [
      ['post', '/api/v0/register'],
      ['get', '/api/v0/users'],
      ['get', '/api/v0/plans'],
      ['get', '/api/v0/admin/invites'],
      ['post', '/api/v0/auth/forgot-password'],
      ['post', '/api/v0/auth/oauth/google'],
      ['post', '/api/v0/account/request-deletion'],
      ['get', '/metrics'],
    ] as const;
    for (const [method, path] of absent) {
      const res = await request(app)[method](path).send({});
      // Unauthenticated: an absent route is 404; `/account/*` sits behind the
      // auth gate of a mounted prefix, so "absent" reads as 401 there.
      expect([404, 401], `${method} ${path}`).toContain(res.status);
      if (!path.startsWith('/api/v0/account')) expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});
