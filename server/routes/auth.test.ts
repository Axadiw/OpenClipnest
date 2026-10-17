import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const {
  mockGetUserByEmail,
  mockGetUserByInternalId,
  mockIsUserLocked,
  mockIsUserBanned,
  mockRecordFailedLogin,
  mockResetLoginAttempts,
  mockGetTokenGeneration,
  mockUpdateUserPasswordByInternalId,
  mockVerifyPassword,
  mockVerifyToken,
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockHashPassword,
  mockValidatePasswordStrength,
  mockBumpTokenGeneration,
  mockForgotPasswordRateLimit,
} = vi.hoisted(() => ({
  mockGetUserByEmail: vi.fn(),
  mockGetUserByInternalId: vi.fn(),
  mockIsUserLocked: vi.fn(),
  mockIsUserBanned: vi.fn(),
  mockRecordFailedLogin: vi.fn(),
  mockResetLoginAttempts: vi.fn(),
  mockGetTokenGeneration: vi.fn(),
  mockUpdateUserPasswordByInternalId: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockVerifyToken: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockHashPassword: vi.fn(),
  mockValidatePasswordStrength: vi.fn(),
  mockBumpTokenGeneration: vi.fn(),
  mockForgotPasswordRateLimit: vi.fn(),
}));

vi.mock('../db/queries/users.js', () => ({
  getUserByEmail: (...a: unknown[]) => mockGetUserByEmail(...a),
  getUserByInternalId: (...a: unknown[]) => mockGetUserByInternalId(...a),
  getTokenGeneration: (...a: unknown[]) => mockGetTokenGeneration(...a),
  bumpTokenGeneration: (...a: unknown[]) => mockBumpTokenGeneration(...a),
  updateUserPasswordByInternalId: (...a: unknown[]) => mockUpdateUserPasswordByInternalId(...a),
  // Passkey/FTPS helpers the core router imports but no asserted branch hits.
  createEmailToken: vi.fn(),
  invalidateEmailTokens: vi.fn(),
  consumeEmailToken: vi.fn(),
  setEmailVerified: vi.fn(),
  activateUser: vi.fn(),
  getUserPasskeySummaries: vi.fn(async () => []),
  insertPasskey: vi.fn(),
  updatePasskeyCounter: vi.fn(),
  deletePasskey: vi.fn(),
  replaceBackupCodes: vi.fn(),
  consumeBackupCode: vi.fn(),
  countUnusedBackupCodes: vi.fn(async () => 0),
  getFtpsState: vi.fn(async () => ({ passkeyEnabled: false, hasFtpsPassword: false, ftpsPasswordHash: null })),
}));

vi.mock('../db/queries/lockout.js', () => ({
  isUserLocked: (...a: unknown[]) => mockIsUserLocked(...a),
  isUserBanned: (...a: unknown[]) => mockIsUserBanned(...a),
  recordFailedLogin: (...a: unknown[]) => mockRecordFailedLogin(...a),
  resetLoginAttempts: (...a: unknown[]) => mockResetLoginAttempts(...a),
}));

vi.mock('../services/auth.js', () => ({
  verifyPassword: (...a: unknown[]) => mockVerifyPassword(...a),
  verifyToken: (...a: unknown[]) => mockVerifyToken(...a),
  generateAccessToken: (...a: unknown[]) => mockGenerateAccessToken(...a),
  generateRefreshToken: (...a: unknown[]) => mockGenerateRefreshToken(...a),
  hashPassword: (...a: unknown[]) => mockHashPassword(...a),
  validatePasswordStrength: (...a: unknown[]) => mockValidatePasswordStrength(...a),
  DUMMY_HASH: '$2b$12$dummyhashvaluefortimingprotection0000000000000000000',
}));

vi.mock('../middleware/rateLimit.js', () => ({
  loginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginEmailRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  refreshTokenRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  // Records the call (so tests can assert the limiter is mounted) then passes through.
  forgotPasswordRateLimit: (req: unknown, res: unknown, next: () => void) => { mockForgotPasswordRateLimit(req, res, next); next(); },
  forgotPasswordEmailRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyResendRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyResendEmailRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  passkeyLoginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  passkeyRegisterRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  passkeyBackupCodeRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginBeginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../utils/redis.js', () => ({
  getRedis: () => ({ set: vi.fn(), getdel: vi.fn(), get: vi.fn() }),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 1, userUuid: 'u-1', email: 'alice@test.com', isAdmin: false };
    next();
  },
}));

vi.mock('../services/audit.js', () => ({
  auditLog: vi.fn(),
}));

import authRouter from './auth.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v0/auth', authRouter);
  return app;
}

describe('auth router', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidatePasswordStrength.mockReturnValue(null);
    app = createApp();
  });

  describe('POST /login', () => {
    it('returns both access and refresh tokens on success', async (ctx) => {
      story(ctx, 'Po prawidłowym logowaniu user dostaje oba tokeny — krótki access do API i długi refresh do odświeżania sesji bez ponownego podawania hasła.');
      mockGetUserByEmail.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
        passwordHash: 'hash', tokenGeneration: 3,
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockIsUserLocked.mockResolvedValue({ locked: false });
      mockVerifyPassword.mockResolvedValue(true);
      mockResetLoginAttempts.mockResolvedValue(undefined);
      mockGenerateAccessToken.mockReturnValue('access-jwt');
      mockGenerateRefreshToken.mockReturnValue('refresh-jwt');

      const res = await request(app)
        .post('/api/v0/auth/login')
        .send({ email: 'alice@test.com', password: 'correct-password' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('access-jwt');
      expect(res.body.refreshToken).toBe('refresh-jwt');
      expect(res.body.user).toEqual({ id: 'uuid-1', email: 'alice@test.com', isAdmin: false, active: true });
      expect(mockGenerateAccessToken).toHaveBeenCalledWith(expect.objectContaining({
        userId: 42, userUuid: 'uuid-1', tokenGen: 3,
      }));
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({
        userId: 42, tokenGen: 3,
      }));
      // Success clears the web channel only — the cameras' FTP counter is theirs.
      expect(mockResetLoginAttempts).toHaveBeenCalledWith(42, 'web');
    });

    it('answers 423 with Retry-After while the web sign-in is locked, without checking the password', async (ctx) => {
      story(ctx, 'Blokada logowania webowego daje 423 z Retry-After i nie porównuje hasła. Sprawdzana jest wyłącznie blokada kanału web — kamera ze starym hasłem (kanał FTP) nie może zablokować właścicielowi logowania.');
      mockGetUserByEmail.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true, passwordHash: 'hash',
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockIsUserLocked.mockResolvedValue({ locked: true, lockedUntil: new Date(Date.now() + 120_000).toISOString() });

      const res = await request(app)
        .post('/api/v0/auth/login')
        .send({ email: 'alice@test.com', password: 'whatever-password' });

      expect(res.status).toBe(423);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(100);
      expect(res.body.retryAfter).toBeGreaterThan(100);
      expect(mockIsUserLocked).toHaveBeenCalledWith(42, 'web');
      expect(mockVerifyPassword).not.toHaveBeenCalled();
    });

    it('counts a wrong password against the web channel', async (ctx) => {
      story(ctx, 'Złe hasło w logowaniu webowym zwiększa licznik kanału web — po 5 takich próbach blokuje się logowanie przez web, nigdy logowanie kamer.');
      mockGetUserByEmail.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true, passwordHash: 'hash',
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockIsUserLocked.mockResolvedValue({ locked: false, lockedUntil: null });
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v0/auth/login')
        .send({ email: 'alice@test.com', password: 'wrong-password' });

      expect(res.status).toBe(401);
      expect(mockRecordFailedLogin).toHaveBeenCalledWith(42, 'web');
      expect(mockResetLoginAttempts).not.toHaveBeenCalled();
    });
  });

  describe('POST /refresh', () => {
    it('issues a new pair when refresh token is valid', async (ctx) => {
      story(ctx, 'Refresh wymienia ważny refresh token na nową parę access/refresh — dzięki temu user nie jest wylogowywany co 15 minut, a zostaje w aplikacji długie godziny.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 5, kind: 'refresh',
      });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockGetTokenGeneration.mockResolvedValue(5);
      mockGenerateAccessToken.mockReturnValue('new-access');
      mockGenerateRefreshToken.mockReturnValue('new-refresh');

      const res = await request(app)
        .post('/api/v0/auth/refresh')
        .send({ refreshToken: 'valid-refresh-jwt' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ token: 'new-access', refreshToken: 'new-refresh' });
    });

    it('rejects missing refresh token with 400', async (ctx) => {
      story(ctx, 'Request bez pola `refreshToken` jest odrzucany z 400 — klient dostaje czytelną informację, że musi spróbować zalogować się ponownie.');
      const res = await request(app).post('/api/v0/auth/refresh').send({});
      expect(res.status).toBe(400);
    });

    it('rejects invalid refresh token with 401', async (ctx) => {
      story(ctx, 'Wygasły lub podrobiony refresh token nie daje nowej sesji — user zostaje wylogowany, co chroni przed nieautoryzowanym dostępem po wycieku tokena.');
      mockVerifyToken.mockImplementation(() => { throw new Error('jwt expired'); });
      const res = await request(app)
        .post('/api/v0/auth/refresh')
        .send({ refreshToken: 'bogus' });
      expect(res.status).toBe(401);
    });

    it('rejects an access token presented at /refresh with 401', async (ctx) => {
      story(ctx, 'Access token nie może pełnić roli refresh tokena — kradzież krótkiego access nie może pozwolić atakującemu na wygenerowanie nowego długoterminowego tokena.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 5, kind: 'access',
      });
      const res = await request(app)
        .post('/api/v0/auth/refresh')
        .send({ refreshToken: 'actually-an-access-token' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/kind/i);
    });

    it('rejects stale refresh token (tokenGen bumped since issue) with 401', async (ctx) => {
      story(ctx, 'Po zmianie hasła user dostaje nowe tokenGeneration — stare tokeny są unieważniane globalnie, więc atakujący z ukradzionym starym refreshem traci dostęp.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 3, kind: 'refresh',
      });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockGetTokenGeneration.mockResolvedValue(5);

      const res = await request(app)
        .post('/api/v0/auth/refresh')
        .send({ refreshToken: 'stale' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/revoked/i);
    });

    it('rejects refresh for a banned user with 403', async (ctx) => {
      story(ctx, 'Zbanowany user nie odświeży sesji mimo prawidłowego refresh tokena — ban wymusza natychmiastowe wylogowanie, nawet gdy kalendarz tokena jeszcze ważny.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 5, kind: 'refresh',
      });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
      });
      mockIsUserBanned.mockResolvedValue({
        banned: true, until: '2099-01-01T00:00:00Z', reason: 'nope', indefinite: false,
      });

      const res = await request(app)
        .post('/api/v0/auth/refresh')
        .send({ refreshToken: 'valid-but-banned' });
      expect(res.status).toBe(403);
      expect(res.body.banned).toBe(true);
    });

    it('rejects refresh for an inactive account with 401', async (ctx) => {
      story(ctx, 'Konto oznaczone jako nieaktywne (np. oczekujące na usunięcie) nie może przedłużyć sesji — inaczej user mógłby wgrywać nagrania po „skasowaniu” konta.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 5, kind: 'refresh',
      });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: false,
      });

      const res = await request(app)
        .post('/api/v0/auth/refresh')
        .send({ refreshToken: 'valid-but-inactive' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /logout', () => {
    it('bumps the token generation for the authenticated user, revoking every session', async (ctx) => {
      story(ctx, 'Wylogowanie unieważnia wszystkie sesje usera — po kradzieży refresh tokena user (lub admin) może wylogować się wszędzie, bo globalny token_generation zostaje podbity i stare tokeny przestają działać.');
      mockBumpTokenGeneration.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/logout');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // userId 1 comes from the requireAuth mock — proves the route is gated by auth
      // and revokes the *current* user's sessions.
      expect(mockBumpTokenGeneration).toHaveBeenCalledWith(1);
    });
  });
});
