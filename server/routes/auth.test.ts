import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  mockCreateSession,
  mockTouchSession,
  mockRevokeSession,
  authUser,
} = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockTouchSession: vi.fn(),
  mockRevokeSession: vi.fn(),
  // What the requireAuth mock puts on req.user; tests set `sid` on it.
  authUser: { current: {} as Record<string, unknown> },
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

vi.mock('../db/queries/sessions.js', () => ({
  createSession: (...a: unknown[]) => mockCreateSession(...a),
  touchSession: (...a: unknown[]) => mockTouchSession(...a),
  revokeSession: (...a: unknown[]) => mockRevokeSession(...a),
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
    req.user = { userId: 1, userUuid: 'u-1', email: 'alice@test.com', isAdmin: false, ...authUser.current };
    next();
  },
}));

vi.mock('../services/audit.js', () => ({
  auditLog: vi.fn(),
}));

import authRouter from './auth.js';
import { installEditionHooks } from '../hooks.js';

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
    mockCreateSession.mockResolvedValue('sid-new');
    authUser.current = {};
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
        userId: 42, userUuid: 'uuid-1', tokenGen: 3, sid: 'sid-new',
      }));
      // Each sign-in opens its own device session.
      expect(mockCreateSession).toHaveBeenCalledWith(42);
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

  describe("the edition's sign-in rule", () => {
    // A stand-in rule (the shared tree knows no edition): refuse an
    // unconfirmed address, the way the hosted edition does.
    beforeEach(() => {
      installEditionHooks({
        signInRefusal: (u) => (u.emailVerified === false ? { status: 403, body: { error: 'confirm', code: 'EMAIL_NOT_VERIFIED' } } : null),
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockIsUserLocked.mockResolvedValue({ locked: false });
      mockGenerateAccessToken.mockReturnValue('access-jwt');
      mockGenerateRefreshToken.mockReturnValue('refresh-jwt');
    });
    afterEach(() => installEditionHooks(undefined));

    const unconfirmed = {
      id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
      emailVerified: false, passwordHash: 'hash', tokenGeneration: 3,
    };

    it('refuses the right password on an unconfirmed address with the rule answer, issuing no tokens', async (ctx) => {
      story(ctx, 'Gdy edycja ma własną regułę logowania (np. adres musi być potwierdzony), poprawne hasło na niepotwierdzonym adresie dostaje 403 EMAIL_NOT_VERIFIED zamiast tokenów i nie otwiera sesji.');
      mockGetUserByEmail.mockResolvedValue(unconfirmed);
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/login').send({ email: 'alice@test.com', password: 'right' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'confirm', code: 'EMAIL_NOT_VERIFIED' });
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockGenerateAccessToken).not.toHaveBeenCalled();
    });

    it('keeps the generic 401 for a wrong password, so the rule reveals nothing', async (ctx) => {
      story(ctx, 'Złe hasło na niepotwierdzonym adresie dostaje zwykłe 401 „Invalid credentials” — bez hasła nie da się sprawdzić, czy konto istnieje ani czy jest potwierdzone.');
      mockGetUserByEmail.mockResolvedValue(unconfirmed);
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app).post('/api/v0/auth/login').send({ email: 'alice@test.com', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid credentials' });
    });

    it('tells an inactive, unconfirmed account to confirm its address first', async (ctx) => {
      story(ctx, 'Konto nieaktywne (czeka na admina) i niepotwierdzone, z poprawnym hasłem, najpierw słyszy „potwierdź adres” — reguła edycji idzie przed sprawdzeniem aktywności.');
      mockGetUserByEmail.mockResolvedValue({ ...unconfirmed, active: false });
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/login').send({ email: 'alice@test.com', password: 'right' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('still answers an inactive, confirmed account with the generic 401', async (ctx) => {
      story(ctx, 'Potwierdzone, ale jeszcze nieaktywne konto dostaje jak dotąd zwykłe 401 — reguła niczego tu nie zmienia.');
      mockGetUserByEmail.mockResolvedValue({ ...unconfirmed, active: false, emailVerified: true });
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/login').send({ email: 'alice@test.com', password: 'right' });

      expect(res.status).toBe(401);
    });

    it('refuses to refresh a session of an unconfirmed account', async (ctx) => {
      story(ctx, 'Sesja sprzed reguły (albo adres, który przestał być potwierdzony) nie odnowi się refreshem — 401 z kodem EMAIL_NOT_VERIFIED, bez nowych tokenów. 401, a nie 403: aplikacje kończą sesję tylko na 401 z refresh i wracają do ekranu logowania, zamiast utknąć w martwej sesji.');
      mockVerifyToken.mockReturnValue({ userId: 42, tokenGen: 3, kind: 'refresh' });
      mockGetUserByInternalId.mockResolvedValue(unconfirmed);
      mockGetTokenGeneration.mockResolvedValue(3);

      const res = await request(app).post('/api/v0/auth/refresh').send({ refreshToken: 'jwt' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(mockGenerateAccessToken).not.toHaveBeenCalled();
    });

    it('signs a confirmed account in as before', async (ctx) => {
      story(ctx, 'Potwierdzone konto loguje się jak dotąd — reguła przepuszcza.');
      mockGetUserByEmail.mockResolvedValue({ ...unconfirmed, emailVerified: true });
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/login').send({ email: 'alice@test.com', password: 'right' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('access-jwt');
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

    it('keeps the device session across a refresh', async (ctx) => {
      story(ctx, 'Refresh zostaje w tej samej sesji urządzenia — dzięki temu wylogowanie na tym urządzeniu później kończy właśnie ją, a nie sesje na innych urządzeniach.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 5, sid: 'sid-phone', kind: 'refresh',
      });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockGetTokenGeneration.mockResolvedValue(5);
      mockTouchSession.mockResolvedValue(true);
      mockGenerateAccessToken.mockReturnValue('new-access');
      mockGenerateRefreshToken.mockReturnValue('new-refresh');

      const res = await request(app).post('/api/v0/auth/refresh').send({ refreshToken: 'jwt' });

      expect(res.status).toBe(200);
      expect(mockTouchSession).toHaveBeenCalledWith('sid-phone', 42);
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({ sid: 'sid-phone' }));
    });

    it('refuses a refresh token whose device session was signed out', async (ctx) => {
      story(ctx, 'Po wylogowaniu na urządzeniu jego refresh token przestaje działać — ktoś, kto go wcześniej skopiował, nie odnowi już tej sesji.');
      mockVerifyToken.mockReturnValue({
        userId: 42, userUuid: 'uuid-1', email: 'alice@test.com', isAdmin: false,
        tokenGen: 5, sid: 'sid-gone', kind: 'refresh',
      });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-1', internalId: 42, email: 'alice@test.com', isAdmin: false, active: true,
      });
      mockIsUserBanned.mockResolvedValue({ banned: false });
      mockGetTokenGeneration.mockResolvedValue(5);
      mockTouchSession.mockResolvedValue(false);

      const res = await request(app).post('/api/v0/auth/refresh').send({ refreshToken: 'jwt' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Refresh token revoked');
      expect(mockGenerateAccessToken).not.toHaveBeenCalled();
    });

    it('opens a session for a refresh token issued before device sessions existed', async (ctx) => {
      story(ctx, 'Stary refresh token bez sesji urządzenia dostaje ją przy najbliższym odświeżeniu — po wdrożeniu nikt nie jest wylogowywany, a od tej chwili jego urządzenie da się wylogować osobno.');
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

      const res = await request(app).post('/api/v0/auth/refresh').send({ refreshToken: 'jwt' });

      expect(res.status).toBe(200);
      expect(mockCreateSession).toHaveBeenCalledWith(42);
      expect(mockTouchSession).not.toHaveBeenCalled();
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({ sid: 'sid-new' }));
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
      expect(res.body.scope).toBe('all');
    });

    it('scope "device" ends only this device\'s session', async (ctx) => {
      story(ctx, 'Wylogowanie na jednym urządzeniu kończy tylko jego sesję — telefon, telewizor i drugi komputer zostają zalogowane.');
      authUser.current = { sid: 'sid-laptop', tokenGen: 2 };
      mockRevokeSession.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/logout').send({ scope: 'device' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, scope: 'device' });
      expect(mockRevokeSession).toHaveBeenCalledWith('sid-laptop', 1);
      expect(mockBumpTokenGeneration).not.toHaveBeenCalled();
    });

    it('scope "all" ends every session even from a device-bound token', async (ctx) => {
      story(ctx, '„Wyloguj ze wszystkich urządzeń” dalej kończy każdą sesję naraz — także dla kont bez hasła, które nie mają innej drogi.');
      authUser.current = { sid: 'sid-laptop', tokenGen: 2 };
      mockBumpTokenGeneration.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/logout').send({ scope: 'all' });

      expect(res.body.scope).toBe('all');
      expect(mockBumpTokenGeneration).toHaveBeenCalledWith(1);
      expect(mockRevokeSession).not.toHaveBeenCalled();
    });

    it('scope "device" on a token without a session ends every session', async (ctx) => {
      story(ctx, 'Token sprzed sesji urządzeń nie wskazuje, którą sesję zamknąć — wylogowanie i tak musi ją zakończyć, więc kończy wszystkie i mówi o tym w odpowiedzi.');
      mockBumpTokenGeneration.mockResolvedValue(true);

      const res = await request(app).post('/api/v0/auth/logout').send({ scope: 'device' });

      expect(res.body.scope).toBe('all');
      expect(mockBumpTokenGeneration).toHaveBeenCalledWith(1);
    });

    it('rejects an unknown scope', async (ctx) => {
      story(ctx, 'Literówka w zakresie wylogowania daje 400 zamiast cichego wylogowania ze wszystkich urządzeń.');
      const res = await request(app).post('/api/v0/auth/logout').send({ scope: 'everything' });
      expect(res.status).toBe(400);
      expect(mockBumpTokenGeneration).not.toHaveBeenCalled();
      expect(mockRevokeSession).not.toHaveBeenCalled();
    });
  });
});
