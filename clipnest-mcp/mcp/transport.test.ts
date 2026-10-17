import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountMcpTransport } from './transport.js';

describe('mountMcpTransport', () => {
  it('mounts POST /mcp and rejects unauthenticated requests with 401', async () => {
    const app = express();
    app.use(express.json());
    mountMcpTransport(app);
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('mounts GET /mcp (SSE upgrade) and rejects unauthenticated requests with 401', async () => {
    const app = express();
    app.use(express.json());
    mountMcpTransport(app);
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('mounts DELETE /mcp (session terminate) and rejects unauthenticated requests with 401', async () => {
    const app = express();
    app.use(express.json());
    mountMcpTransport(app);
    const res = await request(app).delete('/mcp');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });
});
