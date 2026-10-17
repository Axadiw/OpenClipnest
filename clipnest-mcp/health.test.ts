import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mountHealth } from './health.js';

describe('GET /healthz', () => {
  it('returns 200 with db+redis ok', async () => {
    const app = express();
    mountHealth(app, {
      pingDb: vi.fn().mockResolvedValue(undefined),
      pingRedis: vi.fn().mockResolvedValue(undefined),
    });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ db: 'ok', redis: 'ok' });
  });

  it('returns 503 when db is down', async () => {
    const app = express();
    mountHealth(app, {
      pingDb: vi.fn().mockRejectedValue(new Error('down')),
      pingRedis: vi.fn().mockResolvedValue(undefined),
    });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
  });

  it('returns 503 when redis is down', async () => {
    const app = express();
    mountHealth(app, {
      pingDb: vi.fn().mockResolvedValue(undefined),
      pingRedis: vi.fn().mockRejectedValue(new Error('down')),
    });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body.redis).toBe('error');
  });

  it('returns 503 with both errors when both are down', async () => {
    const app = express();
    mountHealth(app, {
      pingDb: vi.fn().mockRejectedValue(new Error('db down')),
      pingRedis: vi.fn().mockRejectedValue(new Error('redis down')),
    });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ db: 'error', redis: 'error' });
  });
});
