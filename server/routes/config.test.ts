import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

vi.mock('../config.js', () => ({
  CONFIG: { appVersion: '1.2.3', publicFtpsHost: 'ftp.example.org', publicFtpsPort: 2121 },
}));

const { createConfigRouter } = await import('./config.js');

describe('GET /api/v0/config', () => {
  it('reports the edition, its features and the FTPS endpoint without auth', async (ctx) => {
    story(ctx, 'Klient (web albo natywny) pyta serwer, co ten potrafi, ZANIM pokaże ekran logowania — dzięki temu ten sam klient obsługuje Clipnest Cloud i instancję self-hosted, chowając przyciski passkey/Google/Apple/rejestracji, których serwer nie ma, i pokazując właściwy host FTPS.');
    const features = { registration: false, passkeys: false, oauthGoogle: false, oauthApple: false, push: false, mcp: true };
    const app = express().use('/api/v0/config', createConfigRouter({ name: 'selfhost', features }));

    const res = await request(app).get('/api/v0/config');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      edition: 'selfhost',
      version: '1.2.3',
      features,
      ftps: { host: 'ftp.example.org', port: 2121 },
      push: null,
    });
  });
});
