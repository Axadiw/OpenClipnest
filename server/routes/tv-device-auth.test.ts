import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';
import { normalizeUserCode } from '../services/tvDeviceAuth.js';

const {
  mockCreateDeviceCode,
  mockApproveDeviceCode,
  mockGetDeviceCodeByDeviceCode,
  mockMarkDeviceCodeUsed,
  mockInvalidatePendingForDevice,
  mockGetUserByInternalId,
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
} = vi.hoisted(() => ({
  mockCreateDeviceCode: vi.fn(),
  mockApproveDeviceCode: vi.fn(),
  mockGetDeviceCodeByDeviceCode: vi.fn(),
  mockMarkDeviceCodeUsed: vi.fn(),
  mockInvalidatePendingForDevice: vi.fn(),
  mockGetUserByInternalId: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
}));

vi.mock('../db/queries/sessions.js', () => ({
  createSession: vi.fn(async () => 'sid-test'),
}));

vi.mock('../db/queries/tvDeviceCodes.js', () => ({
  createDeviceCode: (...a: unknown[]) => mockCreateDeviceCode(...a),
  approveDeviceCode: (...a: unknown[]) => mockApproveDeviceCode(...a),
  getDeviceCodeByDeviceCode: (...a: unknown[]) => mockGetDeviceCodeByDeviceCode(...a),
  markDeviceCodeUsed: (...a: unknown[]) => mockMarkDeviceCodeUsed(...a),
  invalidatePendingDeviceCodesForDevice: (...a: unknown[]) => mockInvalidatePendingForDevice(...a),
  deleteExpiredDeviceCodes: vi.fn(async () => 0),
}));

vi.mock('../db/queries/users.js', () => ({
  getUserByInternalId: (...a: unknown[]) => mockGetUserByInternalId(...a),
}));

vi.mock('../services/auth.js', () => ({
  generateAccessToken: (...a: unknown[]) => mockGenerateAccessToken(...a),
  generateRefreshToken: (...a: unknown[]) => mockGenerateRefreshToken(...a),
}));

vi.mock('../middleware/rateLimit.js', () => ({
  deviceCodeGenerateRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  deviceCodePollRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 1, userUuid: 'u-1', email: 'alice@test.com', isAdmin: false };
    next();
  },
}));

import tvDeviceRouter from './tv-device-auth.js';
import { CONFIG } from '../config.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v0/tv/device', tvDeviceRouter);
  return app;
}

describe('tv device-auth router', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe('POST /code', () => {
    it('mints a user_code + device_code and persists them with a 5-minute expiry', async (ctx) => {
      story(ctx, 'Telewizor prosi o kod: serwer generuje krótki kod dla użytkownika i długi device_code dla telewizora, zapisuje je z 5-minutowym terminem ważności i zwraca adres clipnest.video/tv do wpisania kodu.');
      mockCreateDeviceCode.mockResolvedValue(undefined);

      const res = await request(app).post('/api/v0/tv/device/code').send({});

      expect(res.status).toBe(200);
      expect(typeof res.body.user_code).toBe('string');
      expect(typeof res.body.device_code).toBe('string');
      expect(res.body.interval).toBeGreaterThan(0);
      expect(res.body.expires_in).toBe(300);
      expect(res.body.verification_uri).toBe(`${CONFIG.publicAppUrl}/tv`);

      // The persisted canonical code matches the displayed (dashed) one.
      expect(mockCreateDeviceCode).toHaveBeenCalledTimes(1);
      const arg = mockCreateDeviceCode.mock.calls[0][0] as { userCode: string; deviceCode: string; expiresAt: Date };
      expect(arg.userCode).toBe(normalizeUserCode(res.body.user_code));
      expect(arg.deviceCode).toBe(res.body.device_code);
      expect(arg.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('invalidates earlier pending codes for the same device before minting a new one', async (ctx) => {
      story(ctx, 'Telewizor pokazał kod, użytkownik zaczął go wpisywać, a TV w międzyczasie wygenerował nowy kod (np. po restarcie) — serwer unieważnia poprzedni kod tego urządzenia, więc stary, już niewidoczny kod nie da się zatwierdzić na webie.');
      mockInvalidatePendingForDevice.mockResolvedValue(1);
      mockCreateDeviceCode.mockResolvedValue(undefined);

      const res = await request(app).post('/api/v0/tv/device/code').send({ device_id: 'VENDOR-UUID-1' });

      expect(res.status).toBe(200);
      // Old pending codes for this device are killed first…
      expect(mockInvalidatePendingForDevice).toHaveBeenCalledWith('VENDOR-UUID-1');
      // …and the fresh code is stored bound to that device.
      const arg = mockCreateDeviceCode.mock.calls[0][0] as { deviceId: string | null };
      expect(arg.deviceId).toBe('VENDOR-UUID-1');
    });

    it('skips invalidation when the client sends no device id (older app)', async (ctx) => {
      story(ctx, 'Starsza wersja apki TV nie wysyła identyfikatora urządzenia — wtedy nie unieważniamy nic (brak czego wiązać), a kod zapisujemy bez device_id; zachowanie wstecznie kompatybilne.');
      mockCreateDeviceCode.mockResolvedValue(undefined);

      const res = await request(app).post('/api/v0/tv/device/code').send({});

      expect(res.status).toBe(200);
      expect(mockInvalidatePendingForDevice).not.toHaveBeenCalled();
      const arg = mockCreateDeviceCode.mock.calls[0][0] as { deviceId: string | null };
      expect(arg.deviceId).toBeNull();
    });
  });

  describe('POST /approve', () => {
    it('approves a pending code for the signed-in user', async (ctx) => {
      story(ctx, 'Zalogowany użytkownik wpisuje kod z telewizora — serwer wiąże ten kod z jego kontem, dzięki czemu telewizor przy kolejnym odpytaniu dostanie token tego konkretnego użytkownika.');
      mockApproveDeviceCode.mockResolvedValue({ id: 7, userId: 1, status: 'approved' });

      const res = await request(app).post('/api/v0/tv/device/approve').send({ user_code: 'k7qf-3m9p' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockApproveDeviceCode).toHaveBeenCalledWith('K7QF3M9P', 1);
    });

    it('rejects a malformed code without touching the database', async (ctx) => {
      story(ctx, 'Kod o złym formacie jest odrzucany zanim odpytamy bazę — to tnie koszt i powierzchnię ataku przy próbach zgadywania.');
      const res = await request(app).post('/api/v0/tv/device/approve').send({ user_code: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_code');
      expect(mockApproveDeviceCode).not.toHaveBeenCalled();
    });

    it('returns 400 invalid_or_expired when the code is unknown or already lapsed', async (ctx) => {
      story(ctx, 'Jeśli kod wygasł albo nie istnieje, użytkownik dostaje czytelny błąd i może poprosić telewizor o nowy kod.');
      mockApproveDeviceCode.mockResolvedValue(undefined);
      const res = await request(app).post('/api/v0/tv/device/approve').send({ user_code: 'K7QF3M9P' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_or_expired');
    });
  });

  describe('POST /token', () => {
    it('returns authorization_pending while the user has not yet entered the code', async (ctx) => {
      story(ctx, 'Dopóki użytkownik nie zatwierdzi kodu, telewizor dostaje authorization_pending i wie, że ma dalej odpytywać — to standard flow device-code.');
      mockGetDeviceCodeByDeviceCode.mockResolvedValue({ id: 7, userId: null, status: 'pending', expiresAt: new Date(Date.now() + 60_000) });
      const res = await request(app).post('/api/v0/tv/device/token').send({ device_code: 'dev-xyz' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('authorization_pending');
    });

    it('returns expired_token once the code has lapsed', async (ctx) => {
      story(ctx, 'Po upływie 5 minut kod jest martwy — telewizor dostaje expired_token i pokazuje świeży kod, zamiast w nieskończoność odpytywać o wygasły.');
      mockGetDeviceCodeByDeviceCode.mockResolvedValue({ id: 7, userId: null, status: 'pending', expiresAt: new Date(Date.now() - 1_000) });
      const res = await request(app).post('/api/v0/tv/device/token').send({ device_code: 'dev-xyz' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('expired_token');
    });

    it('issues access+refresh tokens once approved, then burns the code', async (ctx) => {
      story(ctx, 'Po zatwierdzeniu telewizor wymienia device_code na parę tokenów dokładnie taką jak po zwykłym logowaniu; kod jest natychmiast zużywany, więc nie da się go użyć drugi raz.');
      mockGetDeviceCodeByDeviceCode.mockResolvedValue({ id: 7, userId: 42, status: 'approved', expiresAt: new Date(Date.now() + 60_000) });
      mockGetUserByInternalId.mockResolvedValue({
        id: 'uuid-42', internalId: 42, email: 'bob@test.com', isAdmin: false, active: true,
        emailVerified: true, tokenGeneration: 9,
      });
      mockGenerateAccessToken.mockReturnValue('access-jwt');
      mockGenerateRefreshToken.mockReturnValue('refresh-jwt');

      const res = await request(app).post('/api/v0/tv/device/token').send({ device_code: 'dev-xyz' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('access-jwt');
      expect(res.body.refreshToken).toBe('refresh-jwt');
      expect(res.body.user).toEqual({ id: 'uuid-42', email: 'bob@test.com', emailVerified: true, isAdmin: false, active: true });
      expect(mockGenerateAccessToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, userUuid: 'uuid-42', tokenGen: 9 }));
      expect(mockMarkDeviceCodeUsed).toHaveBeenCalledWith(7);
    });

    it('rejects an already-used code with expired_token (single use)', async (ctx) => {
      story(ctx, 'Zużyty kod nie działa po raz drugi — gdyby device_code wyciekł po udanym logowaniu, atakujący i tak nic nim nie zdziała.');
      mockGetDeviceCodeByDeviceCode.mockResolvedValue({ id: 7, userId: 42, status: 'used', expiresAt: new Date(Date.now() + 60_000) });
      const res = await request(app).post('/api/v0/tv/device/token').send({ device_code: 'dev-xyz' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('expired_token');
      expect(mockGenerateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects a missing device_code with invalid_request', async (ctx) => {
      story(ctx, 'Odpytanie bez device_code jest odrzucane — to czysto obronne, broni przed śmieciowymi requestami.');
      const res = await request(app).post('/api/v0/tv/device/token').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });
  });
});
