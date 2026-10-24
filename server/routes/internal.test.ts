import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';
import { installMetricsRecorder, noopRecorder, setSyntheticUserUuids } from '../utils/metrics.js';

/** The synthetic probe's production account, shaped like the configmap value. */
const PROBE_UUID = '11111111-2222-4333-8444-555555555555';

/**
 * The route emits through the metrics facade; a spy recorder captures the
 * (ext, origin) label pairs that would reach the edition's metrics store.
 */
const abortedUploads: Array<[string, string]> = [];
const ftpsLogins: string[] = [];
installMetricsRecorder({
  ...noopRecorder,
  recordFtpsUploadAborted: (ext, origin) => { abortedUploads.push([ext, origin]); },
  recordFtpsLogin: (origin) => { ftpsLogins.push(origin); },
});

// --- Mocks (vi.hoisted runs before vi.mock hoisting) ---

const {
  TEST_INTERNAL_KEY,
  mockGetUserByEmail,
  mockGetUserByUuid,
  mockGetUserQuota,
  mockUpdateDiskUsage,
  mockUpdateTransferUsage,
  mockCheckAndResetTransfer,
  mockIsUserLocked,
  mockRecordFailedLogin,
  mockResetLoginAttempts,
  mockIsIpLocked,
  mockRecordFailedLoginByIp,
  mockVerifyPassword,
  mockAtomicClaimDiskSpace,
  mockCreateNotification,
  mockIsUserBanned,
  mockTrackFileUpload,
  mockGetAutoDeleteOldest,
  mockAutoDeleteOldestUntilFreed,
  mockGetRecentUploadAvgBytes,
  mockEvictUserToFitPlan,
  mockRecordUpload,
  mockHeadObject,
  mockDeleteObject,
  mockReconcileUserQuota,
  mockCompleteUpload,
  mockPublishThumbnailUnique,
  mockClearThumbnailDedup,
  mockIsAccessLocked,
} = vi.hoisted(() => ({
  TEST_INTERNAL_KEY: 'test-internal-key-12345',
  mockGetUserByEmail: vi.fn(),
  mockGetUserByUuid: vi.fn(),
  mockGetUserQuota: vi.fn(),
  mockUpdateDiskUsage: vi.fn(),
  mockUpdateTransferUsage: vi.fn(),
  mockCheckAndResetTransfer: vi.fn(),
  mockIsUserLocked: vi.fn(),
  mockIsUserBanned: vi.fn(),
  mockRecordFailedLogin: vi.fn(),
  mockResetLoginAttempts: vi.fn(),
  mockIsIpLocked: vi.fn(),
  mockRecordFailedLoginByIp: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockAtomicClaimDiskSpace: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockTrackFileUpload: vi.fn().mockResolvedValue({ id: 99, inserted: true }),
  mockGetAutoDeleteOldest: vi.fn(),
  mockAutoDeleteOldestUntilFreed: vi.fn(),
  mockGetRecentUploadAvgBytes: vi.fn(),
  mockEvictUserToFitPlan: vi.fn(),
  mockRecordUpload: vi.fn().mockResolvedValue(undefined),
  mockHeadObject: vi.fn().mockResolvedValue({ contentLength: 12345, lastModified: new Date('2026-04-29T10:00:00.000Z') }),
  mockDeleteObject: vi.fn().mockResolvedValue(undefined),
  mockReconcileUserQuota: vi.fn(),
  mockCompleteUpload: vi.fn().mockResolvedValue({ created: true, state: 'pending_sidecar', eventId: 'evt-001', ownerId: 42 }),
  mockPublishThumbnailUnique: vi.fn().mockResolvedValue('published'),
  mockClearThumbnailDedup: vi.fn().mockResolvedValue(undefined),
  mockIsAccessLocked: vi.fn((..._a: unknown[]) => Promise.resolve(false)),
}));

vi.mock('../config.js', () => ({
  CONFIG: {
    internalApiKey: TEST_INTERNAL_KEY,
  },
}));

vi.mock('../db/queries/users.js', () => ({
  getUserByEmail: (...args: unknown[]) => mockGetUserByEmail(...args),
  getUserByUuid: (...args: unknown[]) => mockGetUserByUuid(...args),
  // Default: caller has no passkey enrolled, so /auth/verify falls through
  // to the legacy password_hash compare. Tests that exercise the passkey
  // branch override this via vi.mocked(...).mockResolvedValueOnce(...).
  getFtpsState: vi.fn(async () => ({ passkeyEnabled: false, hasFtpsPassword: false, ftpsPasswordHash: null })),
}));
vi.mock('../db/queries/storage.js', () => ({
  getUserQuota: (...args: unknown[]) => mockGetUserQuota(...args),
  updateDiskUsage: (...args: unknown[]) => mockUpdateDiskUsage(...args),
  updateTransferUsage: (...args: unknown[]) => mockUpdateTransferUsage(...args),
  checkAndResetTransfer: (...args: unknown[]) => mockCheckAndResetTransfer(...args),
  atomicClaimDiskSpace: (...args: unknown[]) => mockAtomicClaimDiskSpace(...args),
  getAutoDeleteOldest: (...args: unknown[]) => mockGetAutoDeleteOldest(...args),
  recordUpload: (...args: unknown[]) => mockRecordUpload(...args),
}));
vi.mock('../db/queries/events.js', () => ({
  getRecentUploadAvgBytes: (...args: unknown[]) => mockGetRecentUploadAvgBytes(...args),
  trackFileUpload: (...args: unknown[]) => mockTrackFileUpload(...args),
}));
vi.mock('../db/queries/access.js', () => ({ isAccessLocked: (...a: unknown[]) => mockIsAccessLocked(...a) }));

vi.mock('../db/queries/lockout.js', () => ({
  isUserLocked: (...args: unknown[]) => mockIsUserLocked(...args),
  isUserBanned: (...args: unknown[]) => mockIsUserBanned(...args),
  recordFailedLogin: (...args: unknown[]) => mockRecordFailedLogin(...args),
  resetLoginAttempts: (...args: unknown[]) => mockResetLoginAttempts(...args),
  isIpLocked: (...args: unknown[]) => mockIsIpLocked(...args),
  recordFailedLoginByIp: (...args: unknown[]) => mockRecordFailedLoginByIp(...args),
}));
vi.mock('../db/queries/notifications.js', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
}));

vi.mock('../services/autoDelete.js', () => ({
  autoDeleteOldestUntilFreed: (...args: unknown[]) => mockAutoDeleteOldestUntilFreed(...args),
}));

vi.mock('../services/quotaTidy.js', () => ({
  evictUserToFitPlan: (...args: unknown[]) => mockEvictUserToFitPlan(...args),
}));

vi.mock('../services/quota-reconciler.js', () => ({
  reconcileUserQuota: (...args: unknown[]) => mockReconcileUserQuota(...args),
  STORAGE_WARN_EMAIL_THRESHOLD: 0.90,
  QUOTA_WARN_THRESHOLD: 0.95,
}));

vi.mock('../services/auth.js', () => ({
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
  DUMMY_HASH: '$2b$12$dummyhashfortest',
}));

vi.mock('../services/streamsClient.js', () => ({
  publishThumbnailUnique: (...args: unknown[]) => mockPublishThumbnailUnique(...args),
  clearThumbnailDedup: (...args: unknown[]) => mockClearThumbnailDedup(...args),
}));

vi.mock('../services/s3.js', () => ({
  headObject: (...args: unknown[]) => mockHeadObject(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));

vi.mock('../services/ingest/completeUpload.js', () => ({
  completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
}));

// --- App setup ---

import internalRouter from './internal.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  return app;
}

// --- Test data ---

const fakeUser = {
  internalId: 42,
  id: 'uuid-1234-abcd',
  username: 'testuser@test.com',
  passwordHash: '$2b$12$realhashedpassword',
  isAdmin: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  encryptionSalt: 'abc123salt',
  tokenGeneration: 0,
  planId: 1,
  planName: 'Basic',
  diskUsageBytes: 500_000,
  transferUsageBytes: 100_000,
};

const fakeAdminUser = {
  ...fakeUser,
  internalId: 1,
  id: 'uuid-admin-0001',
  username: 'admin@test.com',
  isAdmin: true,
};

const fakeQuota = {
  diskUsageBytes: 500_000,
  diskLimitBytes: 1_073_741_824,
  transferUsageBytes: 100_000,
  transferLimitBytes: 5_368_709_120,
  transferResetAt: '2025-02-01T00:00:00.000Z',
};

// --- Tests ---

describe('Internal API routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();

    // Default mock returns
    mockIsUserLocked.mockReturnValue({ locked: false, lockedUntil: null });
    mockIsUserBanned.mockResolvedValue({ banned: false });
    mockIsIpLocked.mockResolvedValue({ locked: false, lockedUntil: null });
    mockRecordFailedLoginByIp.mockResolvedValue(undefined);
    mockCheckAndResetTransfer.mockReturnValue({
      transferUsageBytes: 100_000,
      transferResetAt: '2025-02-01T00:00:00.000Z',
    });
    mockGetUserQuota.mockReturnValue(fakeQuota);
  });

  // ---------------------------------------------------------------
  // 1. Middleware: rejects requests without X-Internal-Key header
  // ---------------------------------------------------------------
  describe('authentication middleware', () => {
    it('rejects requests without X-Internal-Key header with 403', async (ctx) => {
      story(ctx, 'Endpointy /internal są zarezerwowane dla serwisów wewnętrznych (FTPS, scanner) — brak nagłówka autoryzacji zamyka dostęp z internetu i ochroni kwoty oraz auth przed przypadkowym ujawnieniem.');
      const res = await request(app)
        .post('/internal/auth/verify')
        .send({ email: 'test@test.com', password: 'pass' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid internal API key');
    });

    it('rejects requests with wrong X-Internal-Key with 403', async (ctx) => {
      story(ctx, 'Zły klucz wewnętrzny daje 403 bez informacji, który serwis zna prawdziwy — minimalizuje sygnał dla atakującego próbującego zgadnąć konfigurację.');
      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', 'wrong-key')
        .send({ email: 'test@test.com', password: 'pass' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid internal API key');
    });

    it('rejects GET requests without X-Internal-Key with 403', async (ctx) => {
      story(ctx, 'Zapytania GET o kwotę też wymagają klucza — wszystkie metody są chronione, nie tylko POST, więc atakujący nie ucieknie do „tylko czytania” kwot innych użytkowników.');
      const res = await request(app)
        .get('/internal/users/some-uuid/quota');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid internal API key');
    });
  });

  // ---------------------------------------------------------------
  // 2. POST /internal/auth/verify
  // ---------------------------------------------------------------
  describe('POST /internal/ftps/upload-aborted', () => {
    it('counts a cancelled camera upload and re-buckets the ext label', async (ctx) => {
      story(ctx, 'Kiedy kamera zerwie połączenie w trakcie wysyłania nagrania, FTPS zgłasza to tutaj — to jedyny moment, w którym system w ogóle dowiaduje się o utraconym nagraniu. Endpoint sam kubełkuje `ext`, więc nawet zepsuty klient nie rozszerzy zbioru etykiet Prometheusa.');

      abortedUploads.length = 0;
      const res = await request(app)
        .post('/internal/ftps/upload-aborted')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ext: 'MP4' });

      expect(res.status).toBe(204);
      expect(abortedUploads).toEqual([['mp4', 'organic']]);
    });

    it('buckets an unexpected ext instead of trusting the caller', async () => {
      abortedUploads.length = 0;
      const res = await request(app)
        .post('/internal/ftps/upload-aborted')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ext: 'evil"label' });

      expect(res.status).toBe(204);
      expect(abortedUploads).toEqual([['other', 'organic']]);
    });

    it('files the synthetic probe\'s own aborts under origin=synthetic', async (ctx) => {
      story(ctx, 'Alert "recordings are being lost" mówi o kliencie, a sonda syntetyczna wysyła plik co minutę i przy awarii S3 potrafi seryjnie zrywać własne uploady. Bez tego rozdzielenia jej timeouty stronicowałyby jako utrata nagrań klientów. FTPS dokłada userUuid do zgłoszenia, API zamienia go na dwuwartościowy enum i wyrzuca — sam uuid nigdy nie staje się etykietą.');
      setSyntheticUserUuids(PROBE_UUID);

      abortedUploads.length = 0;
      const res = await request(app)
        .post('/internal/ftps/upload-aborted')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ext: 'mp4', userUuid: PROBE_UUID });

      expect(res.status).toBe(204);
      // The uuid is reduced to the two-member enum before it reaches the
      // recorder — the raw identifier never becomes a label value.
      expect(abortedUploads).toEqual([['mp4', 'synthetic']]);
    });

    it('counts an abort from an older FTPS pod (no userUuid) as organic', async (ctx) => {
      story(ctx, 'DaemonSet FTPS rolluje się stopniowo, więc przez chwilę stare pody zgłaszają zerwane uploady bez userUuid. Brakujące pole musi znaczyć "klient", bo to kierunek, w którym błąd jest widoczny — a nie taki, który po cichu ukrywa utracone nagranie przed alertem.');
      setSyntheticUserUuids(PROBE_UUID);

      abortedUploads.length = 0;
      const res = await request(app)
        .post('/internal/ftps/upload-aborted')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ext: 'jpg' });

      expect(res.status).toBe(204);
      expect(abortedUploads).toEqual([['jpg', 'organic']]);
    });

    it('is still gated by the internal key', async () => {
      const res = await request(app).post('/internal/ftps/upload-aborted').send({ ext: 'mp4' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /internal/auth/verify', () => {
    it('returns valid=true with user info for valid credentials', async (ctx) => {
      story(ctx, 'Serwer FTPS weryfikuje login kamer przez ten endpoint — przy poprawnych danych dostaje userId, UUID i sól do szyfrowania, żeby mógł zapisywać obiekty pod właściwym prefiksem.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'correctPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: true,
        userId: 42,
        userUuid: 'uuid-1234-abcd',
        encryptionSalt: 'abc123salt',
      });
      expect(mockResetLoginAttempts).toHaveBeenCalledWith(42, 'ftp');
    });

    it('counts a successful login as the attempt side of the ingest funnel', async (ctx) => {
      story(ctx, 'Bez licznika PRÓB nie da się zobaczyć awarii, w której sesje kamer umierają w CWD przed STOR: sesje się łączą, ale uploady nie lądują, a licznik przerwanych uploadów nie ma ani jednej serii — klient, który pada przed STOR, nigdy nie dochodzi do salvage_upload. Liczymy to TUTAJ, a nie w Ruście, bo każde logowanie FTPS naprawdę dociera do tej trasy (cache moka w auth.rs karmi UserDetailProvider, nie pomija verify_auth) i bo podział organic/synthetic żyje po tej stronie.');
      setSyntheticUserUuids('');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);

      ftpsLogins.length = 0;
      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'correctPassword1' });

      expect(res.body.valid).toBe(true);
      expect(ftpsLogins).toEqual(['organic']);
    });

    it('files the probe\'s own logins under origin=synthetic, never leaking the uuid', async (ctx) => {
      story(ctx, 'Sonda loguje się co 60 s i wgrywa skutecznie, więc gdyby jej logowania wpadały do kolumny klienta, maskowałyby dokładnie ten sygnał, po który ten licznik istnieje: kamery stukają, a nic nie ląduje. Uuid zamienia się w dwuwartościowy enum i jest wyrzucany — nigdy nie staje się etykietą.');
      setSyntheticUserUuids(fakeUser.id);
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);

      ftpsLogins.length = 0;
      await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'correctPassword1' });

      // The uuid is reduced to the two-member enum before it reaches the
      // recorder — the raw identifier never becomes a label value.
      expect(ftpsLogins).toEqual(['synthetic']);
      setSyntheticUserUuids('');
    });

    it('returns valid=false for invalid credentials', async (ctx) => {
      story(ctx, 'Złe hasło kamery zwraca valid=false i zwiększa licznik prób — to warunek automatycznej blokady konta po zbyt wielu nieudanych logowaniach.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'wrongPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });
      expect(mockRecordFailedLogin).toHaveBeenCalledWith(42, 'ftp');
    });

    it('returns valid=false for non-existent user', async (ctx) => {
      story(ctx, 'Nieistniejący user też przechodzi porównanie hasła z fikcyjnym hashem — wyrównuje czas odpowiedzi i utrudnia atakującemu enumerację kont przez boczne kanały.');
      mockGetUserByEmail.mockReturnValue(undefined);
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'nonexistent@test.com', password: 'anyPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });
      // Should still call verifyPassword for timing safety (against DUMMY_HASH)
      expect(mockVerifyPassword).toHaveBeenCalled();
      // Should NOT record failed login for non-existent user
      expect(mockRecordFailedLogin).not.toHaveBeenCalled();
    });

    it('returns valid=false when missing username or password', async (ctx) => {
      story(ctx, 'Niepełne requesty dają valid=false zamiast 400 — FTPS traktuje to jako błąd logowania, nie crash, żeby kamera spróbowała ponownie.');
      const res1 = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ email: 'testuser@test.com' });

      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ valid: false });

      const res2 = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ password: 'somePass1' });

      expect(res2.status).toBe(200);
      expect(res2.body).toEqual({ valid: false });
    });

    it('returns valid=false with reason for admin users', async (ctx) => {
      story(ctx, 'Admin nie ma kamer ani nagrań — nawet poprawne hasło nie pozwala mu zalogować się przez FTPS, co chroni przed przypadkowym wrzuceniem plików z konta administracyjnego.');
      mockGetUserByEmail.mockReturnValue(fakeAdminUser);
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'admin@test.com', password: 'correctPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false, reason: 'admin_not_allowed' });
    });

    it('returns valid=false with locked info when user is locked out', async (ctx) => {
      story(ctx, 'Zablokowane konto (np. po bruteforce) nie próbuje nawet weryfikować hasła — to chroni przed oszukaniem licznika i pozwala FTPS oddać czas do następnego okna.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockIsUserLocked.mockReturnValue({
        locked: true,
        lockedUntil: '2025-12-31T23:59:59.000Z',
      });

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'anyPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: false,
        locked: true,
        lockedUntil: '2025-12-31T23:59:59.000Z',
      });
      // Only the FTP channel's lockout is consulted — a web lockout never
      // stops the cameras.
      expect(mockIsUserLocked).toHaveBeenCalledWith(42, 'ftp');
      // verifyPassword should NOT be called when user is locked
      expect(mockVerifyPassword).not.toHaveBeenCalled();
    });

    it('returns 500 on unexpected error', async (ctx) => {
      story(ctx, 'Awaria DB przy weryfikacji nie udaje sukcesu — FTPS dostaje 500 i może oddać błąd kamerze, zamiast zapisywać nagranie jako nieautoryzowany tenant.');
      mockGetUserByEmail.mockImplementation(() => {
        throw new Error('DB connection failed');
      });

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'pass' });

      expect(res.status).toBe(500);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toBe('Internal error');
    });

    it('records a per-IP failed login (forwarded X-Real-Client-IP) on bad password', async (ctx) => {
      story(ctx, 'Nieudane logowanie FTPS zwiększa licznik per-IP na podstawie realnego adresu kamery z nagłówka X-Real-Client-IP — to on, a nie współdzielony IP poda FTPS, jest kluczem throttlingu credential-spray rozsianego po wielu loginach.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .set('X-Real-Client-IP', '203.0.113.9')
        .send({ username: 'testuser@test.com', password: 'wrongPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });
      // Both the per-user AND the per-IP counter advance on a real-account miss.
      expect(mockRecordFailedLogin).toHaveBeenCalledWith(42, 'ftp');
      expect(mockRecordFailedLoginByIp).toHaveBeenCalledWith('203.0.113.9', 42);
    });

    it('does NOT advance the per-IP counter when no/invalid client IP is forwarded', async (ctx) => {
      story(ctx, 'Bez wiarygodnego nagłówka X-Real-Client-IP (albo z jego zafałszowaną wartością) throttling per-IP nie rusza — nie zatruwamy licznika śmieciowym „adresem”, który mógłby doprowadzić do blokady losowego IP.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .set('X-Real-Client-IP', 'not-an-ip')
        .send({ username: 'testuser@test.com', password: 'wrongPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });
      expect(mockRecordFailedLogin).toHaveBeenCalledWith(42, 'ftp');
      expect(mockRecordFailedLoginByIp).not.toHaveBeenCalled();
    });

    it('rejects with ipLocked when the source IP tripped the spray throttle, before any password compare', async (ctx) => {
      story(ctx, 'IP który rozsiewał hasła po wielu kontach dostaje twardy lockout — kolejne próby FTPS z tego adresu są odrzucane zanim dotkniemy wiersza użytkownika czy porównamy hasło, więc nawet poprawne dane nie przejdą do czasu wygaśnięcia lub zdjęcia bana przez admina.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);
      mockIsIpLocked.mockResolvedValue({ locked: true, lockedUntil: '2026-01-01T00:00:00.000Z' });

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .set('X-Real-Client-IP', '198.51.100.4')
        .send({ username: 'testuser@test.com', password: 'correctPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: false,
        ipLocked: true,
        lockedUntil: '2026-01-01T00:00:00.000Z',
      });
      expect(mockIsIpLocked).toHaveBeenCalledWith('198.51.100.4');
      // Short-circuits before touching the user row or verifying the password.
      expect(mockVerifyPassword).not.toHaveBeenCalled();
      expect(mockGetUserByEmail).not.toHaveBeenCalled();
    });

    it('does not disturb the successful-login path (no IP lockout, valid password)', async (ctx) => {
      story(ctx, 'Zdrowa kamera z poprawnym hasłem loguje się jak dotąd — dodany guard per-IP nie zmienia happy-path: brak lockoutu IP, brak zapisu nieudanej próby, sukces zwraca komplet danych tenantu.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .set('X-Real-Client-IP', '203.0.113.20')
        .send({ username: 'testuser@test.com', password: 'correctPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: true,
        userId: 42,
        userUuid: 'uuid-1234-abcd',
        encryptionSalt: 'abc123salt',
      });
      expect(mockRecordFailedLoginByIp).not.toHaveBeenCalled();
      expect(mockResetLoginAttempts).toHaveBeenCalledWith(42, 'ftp');
    });
  });

  // ---------------------------------------------------------------
  // 3. GET /internal/users/:uuid/quota
  // ---------------------------------------------------------------
  describe('GET /internal/users/:uuid/quota', () => {
    it('returns correct quota for existing user', async (ctx) => {
      story(ctx, 'Scanner/Event Manager pytają o kwotę przed zapisem pliku — odpowiedź mówi, czy user ma wolne miejsce i ile mu jeszcze zostało do limitu transferu.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .get(`/internal/users/${fakeUser.id}/quota`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...fakeQuota, uploadsBlocked: false });
      expect(mockCheckAndResetTransfer).toHaveBeenCalledWith(42);
      expect(mockGetUserQuota).toHaveBeenCalledWith(42);
    });

    it('returns 404 for non-existent user', async (ctx) => {
      story(ctx, 'Zapytanie o kwotę usera, którego nie ma w DB, zwraca 404 — scanner w razie wyścigu z usuwaniem konta dowie się, że trzeba odpuścić.');
      mockGetUserByUuid.mockReturnValue(undefined);

      const res = await request(app)
        .get('/internal/users/nonexistent-uuid/quota')
        .set('X-Internal-Key', TEST_INTERNAL_KEY);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });

    it('returns 404 when quota not found', async (ctx) => {
      story(ctx, 'Brak wiersza quota w DB (np. user bez planu) daje 404 — inaczej serwisy wewnętrzne dostałyby niejasne zero i pozwoliłyby na nielimitowany upload.');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      mockGetUserQuota.mockReturnValue(undefined);

      const res = await request(app)
        .get(`/internal/users/${fakeUser.id}/quota`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Quota not found');
    });
  });

  // ---------------------------------------------------------------
  // 4. POST /internal/users/:uuid/usage
  // ---------------------------------------------------------------
  describe('POST /internal/users/:uuid/usage', () => {
    it('updates disk and transfer deltas', async (ctx) => {
      story(ctx, 'Po zapisie nowego pliku scanner zgłasza przyrost zużycia dysku i transferu — dzięki temu user widzi aktualne wartości na swoim koncie niemal natychmiast.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/usage`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ diskDelta: 1024, transferDelta: 2048 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.quota).toEqual(fakeQuota);
      expect(mockUpdateDiskUsage).toHaveBeenCalledWith(42, 1024);
      expect(mockUpdateTransferUsage).toHaveBeenCalledWith(42, 2048);
    });

    it('updates only diskDelta when transferDelta is absent', async (ctx) => {
      story(ctx, 'Usunięcie pliku zmniejsza dysk, ale nie transfer — API obsługuje deltę selektywnie, żeby nie krzywdzić usera podwójnie zliczonym transferem.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/usage`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ diskDelta: 512 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockUpdateDiskUsage).toHaveBeenCalledWith(42, 512);
      expect(mockUpdateTransferUsage).not.toHaveBeenCalled();
    });

    it('updates only transferDelta when diskDelta is absent', async (ctx) => {
      story(ctx, 'Sam odczyt pliku (stream do frontu) zwiększa transfer, ale nie dysk — API zapisze tylko potrzebny licznik, zgodnie z semantyką operacji.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/usage`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ transferDelta: 4096 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
      expect(mockUpdateTransferUsage).toHaveBeenCalledWith(42, 4096);
    });

    it('handles negative diskDelta (file deletion)', async (ctx) => {
      story(ctx, 'Skasowanie nagrania odejmuje bajty z licznika dysku — inaczej user nigdy nie odzyskałby kwoty po zwolnieniu miejsca.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/usage`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ diskDelta: -256 });

      expect(res.status).toBe(200);
      expect(mockUpdateDiskUsage).toHaveBeenCalledWith(42, -256);
    });

    it('returns 404 for non-existent user', async (ctx) => {
      story(ctx, 'Zgłoszenie zużycia dla nieistniejącego UUID kończy się 404 — inaczej moglibyśmy dopisywać kwoty do „fantomu” z dziwnymi licznikami w DB.');
      mockGetUserByUuid.mockReturnValue(undefined);

      const res = await request(app)
        .post('/internal/users/nonexistent-uuid/usage')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ diskDelta: 1024 });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });
  });

  // ---------------------------------------------------------------
  // 5. POST /internal/users/:uuid/transfer-check
  // ---------------------------------------------------------------
  describe('POST /internal/users/:uuid/transfer-check', () => {
    it('returns current transfer values when within limit', async (ctx) => {
      story(ctx, 'Przed oddaniem streamu serwis pyta, czy user jest w limicie — jeśli tak, uzyskuje aktualną wartość usage i resetAt do przekazania do throttlera.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/transfer-check`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        transferUsageBytes: 100_000,
        transferResetAt: '2025-02-01T00:00:00.000Z',
        transferLimitBytes: fakeQuota.transferLimitBytes,
        withinLimit: true,
      });
      expect(mockCheckAndResetTransfer).toHaveBeenCalledWith(42);
    });

    it('resets transfer if past reset date and returns fresh values', async (ctx) => {
      story(ctx, 'Miesięczny licznik transferu zeruje się po dacie resetu — użytkownik dostaje świeżą pulę transferu bez pytania o reset ręcznie.');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      // Simulate that checkAndResetTransfer performed a reset
      mockCheckAndResetTransfer.mockReturnValue({
        transferUsageBytes: 0,
        transferResetAt: '2025-03-01T00:00:00.000Z',
      });
      mockGetUserQuota.mockReturnValue({
        ...fakeQuota,
        transferUsageBytes: 0,
        transferResetAt: '2025-03-01T00:00:00.000Z',
      });

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/transfer-check`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        transferUsageBytes: 0,
        transferResetAt: '2025-03-01T00:00:00.000Z',
        transferLimitBytes: fakeQuota.transferLimitBytes,
        withinLimit: true,
      });
    });

    it('returns withinLimit=false when usage exceeds limit', async (ctx) => {
      story(ctx, 'User po przekroczeniu miesięcznego transferu jest oznaczony jako poza limitem — FTPS/Event Manager wie, że trzeba włączyć throttling lub blokadę.');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      const overLimitUsage = fakeQuota.transferLimitBytes + 1000;
      mockCheckAndResetTransfer.mockReturnValue({
        transferUsageBytes: overLimitUsage,
        transferResetAt: '2025-02-01T00:00:00.000Z',
      });
      mockGetUserQuota.mockReturnValue({
        ...fakeQuota,
        transferUsageBytes: overLimitUsage,
      });

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/transfer-check`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.withinLimit).toBe(false);
      expect(res.body.transferUsageBytes).toBe(overLimitUsage);
    });

    it('returns 404 for non-existent user', async (ctx) => {
      story(ctx, 'Transfer-check dla nieistniejącego UUID zwraca 404 — chroni przed dziwnymi wyścigami między usuwaniem konta a streamingiem nagrania.');
      mockGetUserByUuid.mockReturnValue(undefined);

      const res = await request(app)
        .post('/internal/users/nonexistent-uuid/transfer-check')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });

    it('treats a transfer limit of 0 as unlimited', async (ctx) => {
      story(ctx, 'Konto bez planu (albo z planem, który ogranicza tylko dysk — tak działa limit z konfiguracji w wersji self-hosted) ma limit transferu 0. To znaczy „bez limitu", nie „limit wyczerpany": porównanie 0 < 0 blokowało wcześniej każdy upload z kamery.');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      mockGetUserQuota.mockReturnValue({ ...fakeQuota, transferLimitBytes: 0 });

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/transfer-check`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.transferLimitBytes).toBe(0);
      expect(res.body.withinLimit).toBe(true);
    });

    it('returns withinLimit=true when quota is missing (graceful fallback)', async (ctx) => {
      story(ctx, 'Brak wiersza quota nie wylogowuje nagle wszystkich userów — fallback pozwala aplikacji działać, dopóki admin nie skonfiguruje planu.');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      mockGetUserQuota.mockReturnValue(undefined);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/transfer-check`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.withinLimit).toBe(true);
      expect(res.body.transferLimitBytes).toBe(0);
    });
  });

  describe('POST /internal/notifications', () => {
    it('creates a notification with valid kind when auto-delete is OFF', async (ctx) => {
      story(ctx, 'User bez auto-delete dostaje twarde powiadomienie „brak miejsca” w panelu — jedyny sygnał, że uploady są zablokowane i trzeba sprzątnąć ręcznie.');
      mockGetUserByUuid.mockResolvedValue(fakeUser);
      mockGetAutoDeleteOldest.mockResolvedValue(false);
      mockCreateNotification.mockResolvedValue({ id: '42' });

      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          userUuid: fakeUser.id,
          kind: 'storage_quota_exceeded',
          message: 'Disk full',
          details: { attemptedBytes: 1024 },
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: '42' });
      expect(mockCreateNotification).toHaveBeenCalledWith(
        42,
        'storage_quota_exceeded',
        'Disk full',
        { attemptedBytes: 1024 },
      );
    });

    it('suppresses storage_quota_exceeded with 202 when auto-delete is ON', async (ctx) => {
      story(ctx, 'Wymóg usera: notyfikacje „disk quota reached” mają się wyświetlać tylko jak ktoś nie ma włączonego automatycznego usuwania. FTPS i tak woła endpoint na każdym 552 — API gateuje per-user flagą.');
      mockGetUserByUuid.mockResolvedValue(fakeUser);
      mockGetAutoDeleteOldest.mockResolvedValue(true);

      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          userUuid: fakeUser.id,
          kind: 'storage_quota_exceeded',
          message: 'Disk full',
          details: { attemptedBytes: 1024 },
        });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ suppressed: true, reason: 'auto_delete_enabled' });
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('does NOT suppress non-quota kinds even when auto-delete is ON', async (ctx) => {
      story(ctx, 'Gate dotyczy wyłącznie storage_quota_exceeded — pozostałe rodzaje (invalid_file, transfer_quota_exceeded) muszą trafiać do feedu niezależnie od flagi auto-delete.');
      mockGetUserByUuid.mockResolvedValue(fakeUser);
      mockGetAutoDeleteOldest.mockResolvedValue(true);
      mockCreateNotification.mockResolvedValue({ id: '99' });

      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          userUuid: fakeUser.id,
          kind: 'invalid_file',
          message: 'Bad file',
          details: { filename: 'evil.exe' },
        });

      expect(res.status).toBe(201);
      expect(mockCreateNotification).toHaveBeenCalled();
    });

    it('rejects retired auto_deleted_oldest kind (Phase D — silent eviction)', async (ctx) => {
      story(ctx, 'auto_deleted_oldest został wycofany z piszących klientów — endpoint odrzuca jako unknown kind. Stare wpisy w DB nadal się renderują (UI ma ikonę), ale nowe nie są tworzone.');
      mockGetUserByUuid.mockResolvedValue(fakeUser);

      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          userUuid: fakeUser.id,
          kind: 'auto_deleted_oldest',
          message: 'should be rejected',
        });

      expect(res.status).toBe(400);
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('rejects unknown notification kind', async (ctx) => {
      story(ctx, 'Walidacja rodzaju powiadomienia chroni przed pomyłkowym wpisaniem nieznanego typu — inaczej frontend nie wiedziałby, jak wyrenderować taką notyfikację.');
      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ userUuid: fakeUser.id, kind: 'not_a_real_kind', message: 'x' });

      expect(res.status).toBe(400);
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('requires userUuid, kind, and message', async (ctx) => {
      story(ctx, 'Bez UUID, typu i treści nie tworzymy notyfikacji — każdy z tych parametrów jest wymagany, żeby user zobaczył sensowną wiadomość w panelu.');
      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ userUuid: fakeUser.id, kind: 'invalid_file' });

      expect(res.status).toBe(400);
    });

    it('returns 404 when user does not exist', async (ctx) => {
      story(ctx, 'Nie wyślemy notyfikacji do ducha — 404 sygnalizuje serwisowi, że odbiorca już nie istnieje, zamiast trzymać powiadomienia-sieroty w DB.');
      mockGetUserByUuid.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/internal/notifications')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ userUuid: 'nope', kind: 'invalid_file', message: 'x' });

      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------
  // POST /internal/users/:uuid/file-complete  (R1 sync ingest endpoint)
  // -----------------------------------------------------------------
  describe('POST /internal/users/:uuid/file-complete', () => {
    const validBody = {
      s3Bucket: 'clipnest-recordings',
      s3Key: `${fakeUser.id}/Cam01/2026-04-29/clip.mp4`,
      originalFilename: 'clip.mp4',
      fileSizeBytes: 12_345,
    };

    beforeEach(() => {
      vi.resetAllMocks();
      mockGetUserByUuid.mockResolvedValue(fakeUser);
      mockHeadObject.mockResolvedValue({ contentLength: 12_345, lastModified: new Date('2026-04-29T10:00:00.000Z') });
      mockGetUserQuota.mockResolvedValue({
        diskUsageBytes: 500_000,
        diskLimitBytes: 1_073_741_824,
        transferUsageBytes: 0,
        transferLimitBytes: 0,
        transferResetAt: '',
      });
      mockGetAutoDeleteOldest.mockResolvedValue(false);
      mockRecordUpload.mockResolvedValue(undefined);
      mockReconcileUserQuota.mockResolvedValue({ skipped: false, overLimit: false, percent: 0, notified: false, warnEmailSent: false });
      mockCompleteUpload.mockResolvedValue({ created: true, state: 'pending_sidecar', eventId: 'evt-001', ownerId: 42 });
      mockPublishThumbnailUnique.mockResolvedValue('published');
    });

    it('rejects request without X-Internal-Key with 403', async (ctx) => {
      story(ctx, 'file-complete jest chroniony tym samym middleware co wszystkie /internal — brak klucza = 403, żaden z kroków nie jest wywoływany.');

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .send(validBody);

      expect(res.status).toBe(403);
      expect(mockCompleteUpload).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown uuid', async (ctx) => {
      story(ctx, 'Nieznany UUID = 404 — chronimy przed wstrzyknięciem wpisów dla nieistniejących kont.');
      mockGetUserByUuid.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/internal/users/nope/file-complete')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(404);
      expect(mockCompleteUpload).not.toHaveBeenCalled();
    });

    it('returns 400 for missing required fields', async (ctx) => {
      story(ctx, 'Brakujące pola = 400 — walidacja identyczna z /file-uploaded, żeby FTPS dostawał spójne kody błędów.');

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ s3Bucket: 'b', originalFilename: 'f', fileSizeBytes: 100 }); // missing s3Key

      expect(res.status).toBe(400);
      expect(mockCompleteUpload).not.toHaveBeenCalled();
    });

    it('returns 400 for non-finite fileSizeBytes', async (ctx) => {
      story(ctx, 'NaN/Infinity w fileSizeBytes = 400 — to samo zachowanie co /file-uploaded; niedokończony upload z Infinity zniszczyłby liczniki.');

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ...validBody, fileSizeBytes: Infinity });

      expect(res.status).toBe(400);
      expect(mockCompleteUpload).not.toHaveBeenCalled();
    });

    it('returns 507 when quota claim fails (flag OFF, over plan)', async (ctx) => {
      story(ctx, 'Claim odrzucony (over quota, flag OFF): endpoint zwraca 507 {ok:false,claimed:false,reason:quota_exceeded} — FTPS kasuje obiekt S3 i oddaje 552 kamerze. completeUpload nie jest wołany.');
      mockGetUserQuota.mockResolvedValue({
        diskUsageBytes: 1_200_000_000,
        diskLimitBytes: 1_073_741_824,
        transferUsageBytes: 0,
        transferLimitBytes: 0,
        transferResetAt: '',
      });
      mockGetAutoDeleteOldest.mockResolvedValue(false);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(507);
      expect(res.body).toMatchObject({ ok: false, claimed: false, reason: 'quota_exceeded' });
      expect(mockCompleteUpload).not.toHaveBeenCalled();
      expect(mockPublishThumbnailUnique).not.toHaveBeenCalled();
    });

    it('200 happy path — pending_sidecar: completeUpload called + publishThumbnailUnique called + recordUpload called on created=true', async (ctx) => {
      story(ctx, 'Happy path: plik wgrany, quota ok, completeUpload linkuje event, publishThumbnailUnique odpala worker, recordUpload zapisuje telemetrię — wszystko w jednym callbacku, bez dwóch oddzielnych żądań FTPS.');

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        claimed: true,
        created: true,
        state: 'pending_sidecar',
        eventId: 'evt-001',
      });
      expect(mockCompleteUpload).toHaveBeenCalledWith({
        userId: fakeUser.internalId,
        userUuid: fakeUser.id,
        s3Bucket: 'clipnest-recordings',
        s3Key: validBody.s3Key,
        originalFilename: 'clip.mp4',
        fileSizeBytes: 12_345,
        truncated: false,
      });
      expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-001', 42, { notify: true });
      // recordUpload fire-and-forget — flush and assert
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockRecordUpload).toHaveBeenCalledWith(fakeUser.internalId, 12_345);
    });

    it('publishes a thumbnail job for every event the ingest re-homed out of a merge-artifact slot', async (ctx) => {
      story(ctx, 'Kamera dual-view: zoom Cam_01_T+21s trafił najpierw do eventu T (merge w oknie 30 s). Gdy kilka minut później przyszedł prawdziwy Cam_01_T, slot się wyleczył, a T+21s dostał nowy event — bez joba miniaturki, bo plik był już ready i redrive go nie widział. Teraz file-complete publikuje job także dla przeniesionego eventu (bez powiadomienia — plik był już ogłoszony).');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      mockAtomicClaimDiskSpace.mockResolvedValue({ claimed: true, autoDelete: false });
      mockCompleteUpload.mockResolvedValue({
        created: true, state: 'pending_sidecar', eventId: 'evt-keeper', ownerId: 42,
        rehomedEventIds: ['evt-rehomed'],
      });

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-keeper', 42, { notify: true });
      expect(mockPublishThumbnailUnique).toHaveBeenCalledWith('evt-rehomed', 42, { notify: false });
    });

    it('carries the truncated flag through to the ingest', async (ctx) => {
      story(ctx, 'FTPS zapisuje teraz bajty, które dotarły przed zerwaniem połączenia, zamiast je wyrzucać — ale wtedy w bazie ląduje krótszy klip niż ten, który nagrała kamera. Bez tej flagi pół nagrania byłoby nie do odróżnienia od kompletnego.');
      mockGetUserByUuid.mockReturnValue(fakeUser);
      mockAtomicClaimDiskSpace.mockResolvedValue({ claimed: true, autoDelete: false });
      mockCompleteUpload.mockResolvedValue({
        created: true, state: 'pending_sidecar', eventId: 'evt-002', ownerId: 42,
      });

      await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ...validBody, truncated: true });

      expect(mockCompleteUpload).toHaveBeenCalledWith(
        expect.objectContaining({ truncated: true }),
      );
    });

    it('only accepts a literal true, so a stray value cannot mark a complete file', async () => {
      mockGetUserByUuid.mockReturnValue(fakeUser);
      mockAtomicClaimDiskSpace.mockResolvedValue({ claimed: true, autoDelete: false });
      mockCompleteUpload.mockResolvedValue({
        created: true, state: 'pending_sidecar', eventId: 'evt-003', ownerId: 42,
      });

      await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ ...validBody, truncated: 'yes' });

      expect(mockCompleteUpload).toHaveBeenCalledWith(
        expect.objectContaining({ truncated: false }),
      );
    });

    it('does NOT call recordUpload when result.created=false (camera retransmit)', async (ctx) => {
      story(ctx, 'Retransmisja kamery (idempotent re-register, created=false): recordUpload NIE jest wołany — unikamy podwójnego liczenia bajtów w lifetime+30d stats.');
      mockCompleteUpload.mockResolvedValue({ created: false, state: 'pending_sidecar', eventId: 'evt-001', ownerId: 42 });

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockRecordUpload).not.toHaveBeenCalled();
    });

    it('does NOT call publishThumbnailUnique for non-pending_sidecar states', async (ctx) => {
      story(ctx, 'Plik unrecognized (np. .txt) nie trafia do kolejki thumbnail — publishThumbnailUnique odpala się tylko gdy state=pending_sidecar + eventId present.');
      mockCompleteUpload.mockResolvedValue({ created: true, state: 'unrecognized' });

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('unrecognized');
      expect(mockPublishThumbnailUnique).not.toHaveBeenCalled();
    });

    it('still returns 200 when publishThumbnailUnique throws (redrive heals)', async (ctx) => {
      story(ctx, 'publishThumbnailUnique może rzucić gdy Redis jest chwilowo nieosiągalny — endpoint NIE odpowiada błędem (redrive naprawi w ~1 min). Request kończy się 200.');
      mockPublishThumbnailUnique.mockRejectedValue(new Error('Redis down'));

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 502 when HeadObject retries are exhausted + deletes S3 object', async (ctx) => {
      story(ctx, 'HeadObject nie dostaje odpowiedzi po 4 próbach — endpoint usuwa świeżo wgrany obiekt S3 best-effort i zwraca 502. Identyczne zachowanie co /file-uploaded.');
      mockHeadObject.mockRejectedValue(new Error('UnknownError'));

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send(validBody);

      expect(res.status).toBe(502);
      expect(mockHeadObject).toHaveBeenCalledTimes(4);
      expect(mockDeleteObject).toHaveBeenCalledWith('clipnest-recordings', validBody.s3Key);
      expect(mockCompleteUpload).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // Locked account: web sign-in stays, cameras do not.
  describe('locked account', () => {
    beforeEach(() => mockIsAccessLocked.mockResolvedValue(true));
    afterEach(() => mockIsAccessLocked.mockResolvedValue(false));

    const verify = () => request(app)
      .post('/internal/auth/verify')
      .set('X-Internal-Key', TEST_INTERNAL_KEY)
      .send({ username: 'testuser@test.com', password: 'correctPassword1' });

    it('auth/verify refuses the camera login with reason access_locked', async (ctx) => {
      story(ctx, 'Kamera zablokowanego konta nie zaloguje się po FTP — serwer odpowiada valid:false z powodem access_locked, a FTPS zwraca kamerze 530.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);

      const res = await verify();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false, reason: 'access_locked' });
      expect(mockResetLoginAttempts).not.toHaveBeenCalled();
    });

    it('a wrong password on a locked account is still a plain failure', async (ctx) => {
      story(ctx, 'Złe hasło na zablokowanym koncie wygląda jak każde złe hasło — nie zdradzamy stanu konta bez poprawnego hasła.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(false);

      const res = await request(app)
        .post('/internal/auth/verify')
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({ username: 'testuser@test.com', password: 'wrongPassword1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });
    });

    it('transfer-check reports not within limit', async (ctx) => {
      story(ctx, 'Pobieranie przez FTP z zablokowanego konta jest odrzucane jak przy wyczerpanym transferze.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/transfer-check`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.withinLimit).toBe(false);
    });

    it('quota reports uploadsBlocked', async (ctx) => {
      story(ctx, 'Odpowiedź quota mówi wprost, że wgrywanie jest zablokowane.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .get(`/internal/users/${fakeUser.id}/quota`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.uploadsBlocked).toBe(true);
    });

    it('file-complete refuses with 507 and claims nothing', async (ctx) => {
      story(ctx, 'Plik wgrany w sesji otwartej przed blokadą nie zostaje przyjęty — 507, bez naliczania miejsca.');
      mockGetUserByUuid.mockReturnValue(fakeUser);

      const res = await request(app)
        .post(`/internal/users/${fakeUser.id}/file-complete`)
        .set('X-Internal-Key', TEST_INTERNAL_KEY)
        .send({
          s3Bucket: 'clipnest-recordings',
          s3Key: `${fakeUser.id}/Cam01/2026-04-29/clip.mp4`,
          originalFilename: 'clip.mp4',
          fileSizeBytes: 12_345,
        });

      expect(res.status).toBe(507);
      expect(res.body).toEqual({ ok: false, claimed: false, reason: 'access_locked' });
      expect(mockAtomicClaimDiskSpace).not.toHaveBeenCalled();
      expect(mockUpdateDiskUsage).not.toHaveBeenCalled();
      expect(mockCompleteUpload).not.toHaveBeenCalled();
    });

    it('an unlocked account logs in immediately after the lock is lifted', async (ctx) => {
      story(ctx, 'Po odblokowaniu konta kamera loguje się przy następnej próbie — decyzja logowania nie jest nigdzie cache-owana.');
      mockGetUserByEmail.mockReturnValue(fakeUser);
      mockVerifyPassword.mockResolvedValue(true);

      expect((await verify()).body.valid).toBe(false);
      mockIsAccessLocked.mockResolvedValue(false);
      const res = await verify();

      expect(res.body.valid).toBe(true);
    });
  });
});
