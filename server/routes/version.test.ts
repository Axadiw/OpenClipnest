import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

vi.mock('../config.js', () => ({
  CONFIG: { appVersion: 'test-1.2.3' },
}));

import versionRouter from './version.js';

function createApp() {
  const app = express();
  app.use('/api/v0/version', versionRouter);
  return app;
}

describe('GET /api/v0/version', () => {
  it('returns the configured app version', async (ctx) => {
    story(ctx, 'Endpoint /version zwraca wersję aplikacji — frontend używa jej do stopki i do wykrycia nieaktualnego klienta po deployu.');
    const app = createApp();
    const res = await request(app).get('/api/v0/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 'test-1.2.3' });
  });
});
