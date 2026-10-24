import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const { mockVerifyToken, mockGetTokenGeneration, mockGetSessionAuthState, mockIsMcpFamilyActive } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
  mockGetTokenGeneration: vi.fn(),
  mockGetSessionAuthState: vi.fn(),
  mockIsMcpFamilyActive: vi.fn(),
}));

vi.mock('../services/auth.js', () => ({
  verifyToken: (...a: unknown[]) => mockVerifyToken(...a),
}));
vi.mock('../db/queries/users.js', () => ({
  getTokenGeneration: (...a: unknown[]) => mockGetTokenGeneration(...a),
}));
vi.mock('../db/queries/sessions.js', () => ({
  getSessionAuthState: (...a: unknown[]) => mockGetSessionAuthState(...a),
}));
vi.mock('../db/queries/oauth.js', () => ({
  isMcpFamilyActive: (...a: unknown[]) => mockIsMcpFamilyActive(...a),
}));

import { requireAuth } from './auth.js';

function createApp() {
  const app = express();
  app.get('/probe', requireAuth, (req, res) => { res.json({ userId: req.user!.userId }); });
  return app;
}

const base = { userId: 7, userUuid: 'u-7', email: 'a@test.com', isAdmin: false, kind: 'access' };

describe('requireAuth', () => {
  let app: express.Express;
  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('lets a token through while its device session stands', async (ctx) => {
    story(ctx, 'Token zalogowanego urządzenia działa, dopóki jego sesja trwa i konto nie zostało wylogowane wszędzie.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3, sid: 'sid-a' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: true });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(mockGetSessionAuthState).toHaveBeenCalledWith(7, 'sid-a');
    expect(mockGetTokenGeneration).not.toHaveBeenCalled();
  });

  it('refuses a token whose device was signed out, before it expires', async (ctx) => {
    story(ctx, 'Po wylogowaniu urządzenia jego access token przestaje działać od razu, a nie dopiero po 15 minutach.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3, sid: 'sid-a' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 3, sessionActive: false });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token revoked');
  });

  it('refuses a device-bound token after a sign-out everywhere', async (ctx) => {
    story(ctx, '„Wyloguj wszędzie” (albo zmiana hasła) kończy także sesje urządzeń, których wiersze nadal istnieją.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3, sid: 'sid-a' });
    mockGetSessionAuthState.mockResolvedValue({ tokenGeneration: 4, sessionActive: true });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
  });

  it('checks only the generation for a token issued before device sessions', async (ctx) => {
    story(ctx, 'Tokeny sprzed wdrożenia sesji urządzeń działają dalej — nikt nie zostaje wylogowany przez samo wdrożenie.');
    mockVerifyToken.mockReturnValue({ ...base, tokenGen: 3 });
    mockGetTokenGeneration.mockResolvedValue(3);

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(mockGetSessionAuthState).not.toHaveBeenCalled();
  });

  it('never accepts a refresh token as a bearer', async (ctx) => {
    story(ctx, 'Refresh token wysłany jako Bearer jest odrzucany — nawet gdy jego sesja trwa.');
    mockVerifyToken.mockReturnValue({ ...base, kind: 'refresh', tokenGen: 3, sid: 'sid-a' });

    const res = await request(app).get('/probe').set('Authorization', 'Bearer t');

    expect(res.status).toBe(401);
    expect(mockGetSessionAuthState).not.toHaveBeenCalled();
  });
});
