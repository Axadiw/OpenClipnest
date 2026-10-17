import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const {
  mockGetAutoDeleteAfterDays,
  mockSetAutoDeleteAfterDays,
  mockSetAutoDeleteOldest,
  mockGetUserByUuid,
  mockRunRetentionForUser,
  mockEvictUserToFitPlan,
} = vi.hoisted(() => ({
  mockGetAutoDeleteAfterDays: vi.fn(),
  mockSetAutoDeleteAfterDays: vi.fn(),
  mockSetAutoDeleteOldest: vi.fn(),
  mockGetUserByUuid: vi.fn(),
  mockRunRetentionForUser: vi.fn(),
  mockEvictUserToFitPlan: vi.fn(),
}));

vi.mock('../db/queries/storage.js', () => ({
  // Bare-minimum surface used by usage.ts; the retention route is the only
  // one this suite exercises so other helpers can stay no-op stubs.
  getUserQuota: vi.fn(),
  checkAndResetTransfer: vi.fn(),
  getAdminUsageSnapshot: vi.fn().mockResolvedValue([]),
  bulkResetExpiredTransfers: vi.fn().mockResolvedValue(undefined),
  getAutoDeleteOldest: vi.fn(),
  setAutoDeleteOldest: (...args: unknown[]) => mockSetAutoDeleteOldest(...args),
  getAutoDeleteAfterDays: (...args: unknown[]) => mockGetAutoDeleteAfterDays(...args),
  setAutoDeleteAfterDays: (...args: unknown[]) => mockSetAutoDeleteAfterDays(...args),
  getAllUsersUploadStats: vi.fn().mockResolvedValue([]),
  getAllUsersCameraBreakdown: vi.fn().mockResolvedValue([]),
  getDiskUsageByCamera: vi.fn().mockResolvedValue([]),
}));

// Instant-trigger deps wired into usage.ts (v0.10.x): settings changes now fire
// eviction/retention in the background instead of waiting for the cron. Mocked
// so the route stays a pure unit and the fire-and-forget calls are assertable.
vi.mock('../db/queries/users.js', () => ({
  getUserByUuid: (...args: unknown[]) => mockGetUserByUuid(...args),
}));
vi.mock('../services/autoDeleteRetention.js', () => ({
  runRetentionForUser: (...args: unknown[]) => mockRunRetentionForUser(...args),
}));
vi.mock('../services/quotaTidy.js', () => ({
  evictUserToFitPlan: (...args: unknown[]) => mockEvictUserToFitPlan(...args),
}));

import usageRouter from './usage.js';
import { installEditionGuards } from '../middleware/editionGuards.js';

// The cloud edition's owner gate: its operator (admin) account has no
// personal quota. Installed here so the 403 branch is exercised the way it
// is in Clipnest Cloud; a self-hosted install has no gate and passes.
installEditionGuards({
  owner: (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.isAdmin) { res.status(403).json({ error: 'Admin users cannot access recordings' }); return; }
    next();
  },
});

let currentUser: { userId: number; isAdmin: boolean; email: string; userUuid: string } | null = null;

function injectUser(req: Request, _res: Response, next: NextFunction) {
  if (currentUser) req.user = currentUser as Request['user'];
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(injectUser);
  app.use('/api/v0/usage', usageRouter);
  return app;
}

describe('usage — retention endpoints', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: 42, isAdmin: false, email: 'alice@test.com', userUuid: 'alice-uuid' };
    app = createApp();
    mockGetUserByUuid.mockResolvedValue({ internalId: 42, id: 'alice-uuid', encryptionSalt: 'salt' });
    mockRunRetentionForUser.mockResolvedValue({ deleted: 0, freedBytes: 0 });
    mockEvictUserToFitPlan.mockResolvedValue({ deleted: 0, freedBytes: 0, skipped: false });
  });

  describe('GET /auto-delete-after-days', () => {
    it('returns the configured retention window', async (ctx) => {
      story(ctx, 'Strona Storage czyta wartość z usera przy każdym renderze — pole liczbowe ustawia się na zapisaną wartość, żeby user widział własną konfigurację bez konieczności edycji.');
      mockGetAutoDeleteAfterDays.mockResolvedValue(7);
      const res = await request(app).get('/api/v0/usage/auto-delete-after-days');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days: 7 });
    });

    it('returns null when retention is disabled', async (ctx) => {
      story(ctx, 'NULL = retencja wyłączona; UI ukrywa pole liczbowe i pokazuje tylko checkbox. To jasna semantyka „brak konfiguracji”, nie magic number 0.');
      mockGetAutoDeleteAfterDays.mockResolvedValue(null);
      const res = await request(app).get('/api/v0/usage/auto-delete-after-days');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days: null });
    });

    it('blocks unauthenticated access', async (ctx) => {
      story(ctx, '401 dla niezalogowanego — żaden niezweryfikowany klient nie może odczytać konfiguracji usera nawet jeśli wartość sama w sobie nie jest sekretem.');
      currentUser = null;
      const res = await request(app).get('/api/v0/usage/auto-delete-after-days');
      expect(res.status).toBe(401);
    });

    it('rejects admin caller', async (ctx) => {
      story(ctx, 'Admin nie ma własnej kwoty — endpoint user-storage zwraca 403, żeby admin nie zobaczył w swoim Storage tabie nic mylącego ani nie dostał błędnej wartości NULL z DB.');
      currentUser = { userId: 1, isAdmin: true, email: 'admin@x', userUuid: 'admin-uuid' };
      const res = await request(app).get('/api/v0/usage/auto-delete-after-days');
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /auto-delete-after-days', () => {
    it('persists a valid integer day window', async (ctx) => {
      story(ctx, 'Ustawienie 30 dni leci do bazy — dla średniego usera Reolinka to rozsądny default, więc UI proponuje go jako wartość startową przy pierwszej aktywacji.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: 30 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days: 30 });
      expect(mockSetAutoDeleteAfterDays).toHaveBeenCalledWith(42, 30);
    });

    it('clears the window when days is null', async (ctx) => {
      story(ctx, 'Wyłączenie checkboxa wysyła days=null — DB ustawia kolumnę na NULL i retention cron przestaje przerabiać tego usera. Brak wartości = brak retencji.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: null });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days: null });
      expect(mockSetAutoDeleteAfterDays).toHaveBeenCalledWith(42, null);
    });

    it('rejects 0 days', async (ctx) => {
      story(ctx, 'days=0 oznaczałoby „skasuj WSZYSTKO” — endpoint odmawia, bo to praktycznie wyzeruje bibliotekę. Disable = null, nie 0.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: 0 });
      expect(res.status).toBe(400);
      expect(mockSetAutoDeleteAfterDays).not.toHaveBeenCalled();
    });

    it('rejects 366 days (out of range)', async (ctx) => {
      story(ctx, 'Górny cap 365 dni — nie ma sensu trzymać retencji dłuższej niż rok, a większe wartości łatwo wpisać przez pomyłkę. Walidacja chroni dane userów.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: 366 });
      expect(res.status).toBe(400);
    });

    it('rejects non-integer values', async (ctx) => {
      story(ctx, 'Float jak 7.5 dnia nie ma sensu w semantyce retencji — wymaga okrągłej liczby dni, więc niepełne wartości są odrzucane przez walidację.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: 7.5 });
      expect(res.status).toBe(400);
    });

    it('rejects negative values', async (ctx) => {
      story(ctx, 'Wartość ujemna jest nonsensem dla okna retencji — walidacja chroni przed bug-em w UI/CLI integratorach, gdzie stara wartość mogłaby zostać przekazana jako -1.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: -3 });
      expect(res.status).toBe(400);
    });

    it('rejects string values', async (ctx) => {
      story(ctx, 'Body \'days: "7"\' zamiast number jest oznaką źle napisanego klienta — odrzucamy zamiast cicho coercować, co maskowałoby buga u callera.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: '7' });
      expect(res.status).toBe(400);
    });

    it('returns 403 for admins', async (ctx) => {
      story(ctx, 'Admin nie ma kwoty ani retencji — PUT też się odbija 403, żeby przypadkowy „save” w admin UI nie zapisał na koncie admina ustawienia, którego cron nigdy nie wykona.');
      currentUser = { userId: 1, isAdmin: true, email: 'admin@x', userUuid: 'admin-uuid' };
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: 30 });
      expect(res.status).toBe(403);
    });

    it('fires an instant retention sweep for the user after the window is set', async (ctx) => {
      story(ctx, 'Skrócenie okna retencji nie czeka 1 min na crona — endpoint od razu odpala runRetentionForUser w tle dla tego usera, więc pliki starsze niż nowe okno znikają niemal natychmiast. Cron zostaje tylko jako backstop.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: 14 });
      expect(res.status).toBe(200);
      expect(mockGetUserByUuid).toHaveBeenCalledWith('alice-uuid');
      // setImmediate defers the fire-and-forget sweep past the response — flush it.
      await new Promise((r) => setImmediate(r));
      expect(mockRunRetentionForUser).toHaveBeenCalledWith(42, 'alice-uuid', 'salt', 14);
    });

    it('does NOT sweep when retention is cleared (days null)', async (ctx) => {
      story(ctx, 'Wyłączenie retencji (null) to zdjęcie polityki, nie polecenie kasowania — żadne pliki nie są usuwane, runRetentionForUser nie jest wołane.');
      const res = await request(app)
        .put('/api/v0/usage/auto-delete-after-days')
        .send({ days: null });
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mockRunRetentionForUser).not.toHaveBeenCalled();
      expect(mockGetUserByUuid).not.toHaveBeenCalled();
    });
  });

  describe('PUT /auto-delete (toggle) — instant eviction', () => {
    it('fires instant eviction when enabling auto-delete-oldest', async (ctx) => {
      story(ctx, 'Włączenie auto-usuwania, gdy user już jest ponad limitem, od razu zwalnia miejsce zamiast czekać 1 min na crona. evictUserToFitPlan jest idempotentny i pod advisory-lockiem, więc bezpiecznie dubluje się z cronem i triggerem po uploadzie.');
      const res = await request(app).put('/api/v0/usage/auto-delete').send({ enabled: true });
      expect(res.status).toBe(200);
      expect(mockSetAutoDeleteOldest).toHaveBeenCalledWith(42, true);
      expect(mockGetUserByUuid).toHaveBeenCalledWith('alice-uuid');
      await new Promise((r) => setImmediate(r));
      expect(mockEvictUserToFitPlan).toHaveBeenCalledWith(42, 'alice-uuid', 'salt');
    });

    it('does NOT evict when disabling auto-delete-oldest', async (ctx) => {
      story(ctx, 'Wyłączenie auto-usuwania to zmiana polityki na przyszłość, nie polecenie kasowania — nic nie jest usuwane natychmiast.');
      const res = await request(app).put('/api/v0/usage/auto-delete').send({ enabled: false });
      expect(res.status).toBe(200);
      expect(mockSetAutoDeleteOldest).toHaveBeenCalledWith(42, false);
      await new Promise((r) => setImmediate(r));
      expect(mockEvictUserToFitPlan).not.toHaveBeenCalled();
    });
  });
});
