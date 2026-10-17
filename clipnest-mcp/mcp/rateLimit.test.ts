import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { perTokenRateLimit, type RateLimitOpts } from './rateLimit.js';

// The middleware's own logic (key choice, 429 + Retry-After) runs against an
// in-memory store with the same options, so the suite needs no Redis — the
// shared Redis store itself is rate-limiter-flexible's code, not ours.
const limitWith = (opts: RateLimitOpts) =>
  perTokenRateLimit(opts, new RateLimiterMemory({ keyPrefix: opts.keyPrefix, points: opts.points, duration: opts.durationSec }));

describe('perTokenRateLimit', () => {
  it('allows up to N requests per token, then 429 with Retry-After', async () => {
    const app = express();
    const tokenA = randomBytes(8).toString('hex');
    app.use((req, _res, next) => { (req as any).tokenForLimit = tokenA; next(); });
    app.use(limitWith({ points: 3, durationSec: 60, keyPrefix: `t-${tokenA}` }));
    app.use((_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/').send({});
      expect(r.status).toBe(200);
    }
    const r4 = await request(app).post('/').send({});
    expect(r4.status).toBe(429);
    expect(r4.headers['retry-after']).toBeDefined();
    expect(Number(r4.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('separates buckets per token', async () => {
    const app = express();
    const tokenA = randomBytes(8).toString('hex');
    const tokenB = randomBytes(8).toString('hex');
    const prefix = `t-${randomBytes(4).toString('hex')}`;
    app.use((req, _res, next) => {
      (req as any).tokenForLimit = req.headers['x-test-token'] as string;
      next();
    });
    app.use(limitWith({ points: 2, durationSec: 60, keyPrefix: prefix }));
    app.use((_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 2; i++) {
      await request(app).post('/').set('X-Test-Token', tokenA).send({});
    }
    expect((await request(app).post('/').set('X-Test-Token', tokenA).send({})).status).toBe(429);
    // tokenA exhausted, tokenB still fresh
    const r = await request(app).post('/').set('X-Test-Token', tokenB).send({});
    expect(r.status).toBe(200);
  });
});
