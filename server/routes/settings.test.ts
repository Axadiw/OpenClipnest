import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const {
  mockGetCameraProfileSettings,
  mockSetCameraProfileMode,
  mockInsertUserCameraProfile,
  mockUpdateUserCameraProfile,
  mockDeleteUserCameraProfile,
  mockResetUserCameraProfiles,
  mockGetUserTimezone,
  mockSetUserTimezone,
} = vi.hoisted(() => ({
  mockGetCameraProfileSettings: vi.fn(),
  mockSetCameraProfileMode: vi.fn(),
  mockInsertUserCameraProfile: vi.fn(),
  mockUpdateUserCameraProfile: vi.fn(),
  mockDeleteUserCameraProfile: vi.fn(),
  mockResetUserCameraProfiles: vi.fn(),
  mockGetUserTimezone: vi.fn(),
  mockSetUserTimezone: vi.fn(),
}));

let currentUser: { userId: number; isAdmin: boolean; email: string; userUuid: string } | null = null;

vi.mock('../db/queries/cameraProfiles.js', () => ({
  getCameraProfileSettings: (...args: unknown[]) => mockGetCameraProfileSettings(...args),
  setCameraProfileMode: (...args: unknown[]) => mockSetCameraProfileMode(...args),
  insertUserCameraProfile: (...args: unknown[]) => mockInsertUserCameraProfile(...args),
  updateUserCameraProfile: (...args: unknown[]) => mockUpdateUserCameraProfile(...args),
  deleteUserCameraProfile: (...args: unknown[]) => mockDeleteUserCameraProfile(...args),
  resetUserCameraProfiles: (...args: unknown[]) => mockResetUserCameraProfiles(...args),
}));
vi.mock('../db/queries/events.js', () => ({
  getUserTimezone: (...args: unknown[]) => mockGetUserTimezone(...args),
  setUserTimezone: (...args: unknown[]) => mockSetUserTimezone(...args),
}));

import settingsRouter from './settings.js';
import { VENDOR_PROFILE_TEMPLATES } from '../config/cameraProfiles.js';
import { _shutdownRegexWorker } from '../services/untrustedRegex.js';

const AXIS_TEMPLATE = VENDOR_PROFILE_TEMPLATES.find(t => t.name === 'Axis')!;
const FOSCAM_TEMPLATE = VENDOR_PROFILE_TEMPLATES.find(t => t.name === 'Foscam')!;

function injectUser(req: Request, _res: Response, next: NextFunction) {
  if (currentUser) req.user = currentUser as Request['user'];
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(injectUser);
  app.use('/api/v0/settings', settingsRouter);
  return app;
}

const ALICE_UUID = 'alice-uuid';

const sampleProfile = {
  id: 1,
  name: 'My Cam',
  regex: '^(?<camera>.+)_(?<ts>\\d{14})\\.(?<ext>mp4)$',
  viewDefault: '00' as const,
  viewsConfig: [{ id: '00', iconKind: 'generic' as const }],
  priority: 0,
  enabled: true,
  createdAt: '2026-05-01T10:00:00.000Z',
};

describe('settings router — camera profiles', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: 42, isAdmin: false, email: 'alice@test.com', userUuid: ALICE_UUID };
    app = createApp();
  });

  // The /camera-profiles/test endpoint runs untrusted regexes in a worker
  // thread; close it so the test process can exit.
  afterAll(async () => { await _shutdownRegexWorker(); });

  // ---------------------------------------------------------------------------
  // GET /camera-profiles
  // ---------------------------------------------------------------------------

  it('GET returns mode and custom profiles for the authenticated user', async (ctx) => {
    story(ctx, 'User otwiera stronę ustawień kamer — API zwraca aktualny tryb i listę custom profili.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'auto', profiles: [sampleProfile] });

    const res = await request(app).get('/api/v0/settings/camera-profiles');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('auto');
    expect(res.body.customProfiles).toEqual([sampleProfile]);
    // The 4 vendor templates the client seeds into custom mode are surfaced here.
    expect(res.body.templates.map((t: { name: string }) => t.name))
      .toEqual(['Reolink', 'Hikvision', 'Axis', 'Foscam']);
    expect(mockGetCameraProfileSettings).toHaveBeenCalledWith(ALICE_UUID);
  });

  it('GET returns empty customProfiles array when user has none', async (ctx) => {
    story(ctx, 'Nowy user bez żadnych custom profili widzi pustą listę — nie crash, tylko [].');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'reolink', profiles: [] });

    const res = await request(app).get('/api/v0/settings/camera-profiles');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('reolink');
    expect(res.body.customProfiles).toEqual([]);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // POST /camera-profiles/reset — atomic delete-all + seed, NO cap check
  // ---------------------------------------------------------------------------

  it('POST reset seeds the 4 vendor templates with priorities 10/20/30/40 and returns them', async (ctx) => {
    story(ctx, 'User resetuje profile do domyślnych — serwer atomowo kasuje stare i sieje szablony vendorów.');
    const seeded = VENDOR_PROFILE_TEMPLATES.map((t, i) => ({
      ...sampleProfile,
      id: i + 1,
      name: t.name,
      regex: t.regex,
      viewsConfig: t.viewsConfig,
      priority: (i + 1) * 10,
    }));
    mockResetUserCameraProfiles.mockResolvedValue(seeded);

    const res = await request(app).post('/api/v0/settings/camera-profiles/reset');
    expect(res.status).toBe(200);
    expect(res.body.customProfiles).toHaveLength(4);
    expect(res.body.customProfiles.map((p: { name: string }) => p.name))
      .toEqual(['Reolink', 'Hikvision', 'Axis', 'Foscam']);
    expect(mockResetUserCameraProfiles).toHaveBeenCalledWith(
      ALICE_UUID,
      VENDOR_PROFILE_TEMPLATES.map((t, i) => ({
        name: t.name,
        regex: t.regex,
        viewsConfig: t.viewsConfig,
        priority: (i + 1) * 10,
      })),
    );
  });

  it('POST reset works at the 20-profile cap — the cap path is never consulted', async (ctx) => {
    story(ctx, 'User z 20 profilami (cap) resetuje — atomowy delete+seed w transakcji omija cap, bez 400.');
    // The old client-driven flow (seed 4 via POST /custom, then delete) 400'd
    // here because seeding pushed past CUSTOM_PROFILE_CAP before the deletes.
    // The reset endpoint deletes first INSIDE the transaction, so the cap can
    // never bite — pinned by asserting the cap-consulting query is not called.
    mockResetUserCameraProfiles.mockResolvedValue([sampleProfile]);

    const res = await request(app).post('/api/v0/settings/camera-profiles/reset');
    expect(res.status).toBe(200);
    expect(mockGetCameraProfileSettings).not.toHaveBeenCalled();
  });

  it('POST reset maps a query failure to 500', async (ctx) => {
    story(ctx, 'Awaria bazy w trakcie resetu — transakcja się wycofuje, API zwraca 500, stare profile zostają.');
    mockResetUserCameraProfiles.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/v0/settings/camera-profiles/reset');
    expect(res.status).toBe(500);
  });

  // ---------------------------------------------------------------------------
  // PUT /camera-profiles/mode
  // ---------------------------------------------------------------------------

  it('PUT mode updates to a valid mode and returns it', async (ctx) => {
    story(ctx, 'User przełącza tryb na hikvision — API akceptuje, zapisuje i odsyła potwierdzenie.');
    mockSetCameraProfileMode.mockResolvedValue(undefined);

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/mode')
      .send({ mode: 'hikvision' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'hikvision' });
    expect(mockSetCameraProfileMode).toHaveBeenCalledWith(ALICE_UUID, 'hikvision');
  });

  it('PUT mode rejects an unknown mode with 400', async (ctx) => {
    story(ctx, 'User wysyła nieprawidłowy tryb — API zwraca 400 z opisem błędu, bez zapisu do bazy.');
    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/mode')
      .send({ mode: 'dahua' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid mode/i);
    expect(mockSetCameraProfileMode).not.toHaveBeenCalled();
  });

  it('PUT mode rejects a missing mode field with 400', async (ctx) => {
    story(ctx, 'Pusty body powoduje 400 — guard broni przed undefined w bazie.');
    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/mode')
      .send({});
    expect(res.status).toBe(400);
  });

  it('PUT mode accepts all valid mode values', async (ctx) => {
    story(ctx, 'Każdy z 6 dozwolonych trybów przechodzi walidację — regresja, że nie odcięto żadnej wartości enumu.');
    mockSetCameraProfileMode.mockResolvedValue(undefined);
    const modes = ['auto', 'reolink', 'hikvision', 'axis', 'foscam', 'custom'];
    for (const mode of modes) {
      const res = await request(app)
        .put('/api/v0/settings/camera-profiles/mode')
        .send({ mode });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe(mode);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /camera-profiles/custom
  // ---------------------------------------------------------------------------

  it('POST custom creates a profile and returns 201 with the new profile', async (ctx) => {
    story(ctx, 'User dodaje nowy custom profil z poprawnym regex — API go tworzy i odsyła z id i datą.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });
    mockInsertUserCameraProfile.mockResolvedValue(sampleProfile);

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'My Cam', regex: '^test$', viewsConfig: [{ id: '00', iconKind: 'generic' }], priority: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(sampleProfile);
    expect(mockInsertUserCameraProfile).toHaveBeenCalledWith(ALICE_UUID, {
      name: 'My Cam',
      regex: '^test$',
      viewsConfig: [{ id: '00', iconKind: 'generic' }],
      priority: 5,
    });
  });

  it('POST custom synthesizes viewsConfig from legacy viewDefault', async (ctx) => {
    story(ctx, 'Stary klient wysyła tylko viewDefault (bez viewsConfig) — API syntetyzuje jednowidokowy config z ikoną generic dla wstecznej kompatybilności.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });
    mockInsertUserCameraProfile.mockResolvedValue(sampleProfile);

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'My Cam', regex: '^test$', viewDefault: '01', priority: 5 });
    expect(res.status).toBe(201);
    expect(mockInsertUserCameraProfile).toHaveBeenCalledWith(ALICE_UUID, {
      name: 'My Cam',
      regex: '^test$',
      viewsConfig: [{ id: '01', iconKind: 'generic' }],
      priority: 5,
    });
  });

  it('POST custom uses defaults for optional fields', async (ctx) => {
    story(ctx, 'viewsConfig i priority są opcjonalne — brak ich w body powinien domyślnie dać jednowidokowy config "00"/generic i priorytet 0.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });
    mockInsertUserCameraProfile.mockResolvedValue(sampleProfile);

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'My Cam', regex: '^test$' });
    expect(res.status).toBe(201);
    expect(mockInsertUserCameraProfile).toHaveBeenCalledWith(ALICE_UUID, {
      name: 'My Cam',
      regex: '^test$',
      viewsConfig: [{ id: '00', iconKind: 'generic' }],
      priority: 0,
    });
  });

  it('POST custom accepts a multi-view viewsConfig with per-view icons', async (ctx) => {
    story(ctx, 'User definiuje wielowidokowy profil z różnymi ikonami na widok — API przekazuje pełną tablicę viewsConfig do bazy.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });
    mockInsertUserCameraProfile.mockResolvedValue(sampleProfile);

    const viewsConfig = [
      { id: '00', iconKind: 'wide' },
      { id: '01', iconKind: 'tele' },
      { id: 'door', iconKind: 'doorbell' },
    ];
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Multi', regex: '^test$', viewsConfig });
    expect(res.status).toBe(201);
    expect(mockInsertUserCameraProfile).toHaveBeenCalledWith(ALICE_UUID, {
      name: 'Multi',
      regex: '^test$',
      viewsConfig,
      priority: 0,
    });
  });

  it('POST custom rejects viewsConfig with an invalid iconKind (400)', async (ctx) => {
    story(ctx, 'iconKind musi być jedną z 8 dozwolonych wartości — nieznana wartość jest odrzucana z 400, nim trafi do bazy.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Bad', regex: '^test$', viewsConfig: [{ id: '00', iconKind: 'banana' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/iconKind/i);
    expect(mockInsertUserCameraProfile).not.toHaveBeenCalled();
  });

  it('POST custom rejects an empty viewsConfig array (400)', async (ctx) => {
    story(ctx, 'Profil musi mieć co najmniej jeden widok — pusta tablica viewsConfig jest odrzucana z 400.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Empty', regex: '^test$', viewsConfig: [] });
    expect(res.status).toBe(400);
    expect(mockInsertUserCameraProfile).not.toHaveBeenCalled();
  });

  it('POST custom rejects a viewsConfig entry with an oversized id (400)', async (ctx) => {
    story(ctx, 'Każdy id widoku to string długości 1..16 — wartość >16 znaków jest odrzucana z 400 (length guard chroni DB).');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Big', regex: '^test$', viewsConfig: [{ id: 'x'.repeat(17), iconKind: 'generic' }] });
    expect(res.status).toBe(400);
    expect(mockInsertUserCameraProfile).not.toHaveBeenCalled();
  });

  it('POST custom rejects invalid regex with 400', async (ctx) => {
    story(ctx, 'Nieprawidłowy regex daje 400 — błąd jest wychwytywany zanim trafi do bazy.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Bad Cam', regex: '(?invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid regex/i);
    expect(mockInsertUserCameraProfile).not.toHaveBeenCalled();
  });

  it('POST custom rejects empty name with 400', async (ctx) => {
    story(ctx, 'Pusta nazwa profilu jest odrzucana z 400 — walidacja broni przed pustymi wpisami w bazie.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: '   ', regex: '^test$' });
    expect(res.status).toBe(400);
  });

  it('POST custom rejects oversized viewDefault with 400', async (ctx) => {
    story(ctx, 'viewDefault jest profile-defined stringiem długości 1..16 (Reolink ma "00"/"01", custom profile mogą dać dowolny). Wartości >16 znaków albo puste są odrzucane — length guard chroni DB CHECK.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Cam', regex: '^test$', viewDefault: 'x'.repeat(17) });
    expect(res.status).toBe(400);

    const empty = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'Cam', regex: '^test$', viewDefault: '' });
    expect(empty.status).toBe(400);
  });

  it('POST custom enforces 20-profile cap with 400', async (ctx) => {
    story(ctx, 'User ma już 20 profili — API odmawia dodania 21. i zwraca 400, bez zapytania INSERT.');
    const full20 = Array.from({ length: 20 }, (_, i) => ({ ...sampleProfile, id: i + 1 }));
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: full20 });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'One Too Many', regex: '^test$' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20/);
    expect(mockInsertUserCameraProfile).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // PUT /camera-profiles/custom/:id
  // ---------------------------------------------------------------------------

  it('PUT custom/:id updates a profile and returns 200 with the updated profile', async (ctx) => {
    story(ctx, 'User edytuje nazwę istniejącego profilu — API aktualizuje i odsyła aktualną wersję.');
    mockUpdateUserCameraProfile.mockResolvedValue({ ...sampleProfile, name: 'Renamed' });

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(mockUpdateUserCameraProfile).toHaveBeenCalledWith(1, ALICE_UUID, { name: 'Renamed' });
  });

  it('PUT custom/:id returns 404 when profile not found or belongs to another user', async (ctx) => {
    story(ctx, 'Próba edycji cudzego profilu lub nieistniejącego ID daje 404 — izolacja danych między userami.');
    mockUpdateUserCameraProfile.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/999')
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('PUT custom/:id returns 400 on empty body', async (ctx) => {
    story(ctx, 'Wysłanie pustego body do PATCH-like endpointu zwraca 400 — nie ma sensu robić UPDATE bez danych.');
    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
    expect(mockUpdateUserCameraProfile).not.toHaveBeenCalled();
  });

  it('PUT custom/:id returns 400 for non-numeric id', async (ctx) => {
    story(ctx, 'Nienumeryczne ID w URL jest odrzucane z 400 — zapobiega przekazaniu NaN do bazy.');
    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/abc')
      .send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/numeric/i);
  });

  it('PUT custom/:id validates regex if provided', async (ctx) => {
    story(ctx, 'Aktualizacja z błędnym regex jest odrzucana — walidacja przy UPDATE jest tak samo ważna jak przy INSERT.');
    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ regex: '[bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid regex/i);
  });

  it('PUT custom/:id can toggle enabled flag', async (ctx) => {
    story(ctx, 'User wyłącza profil — enabled=false jest akceptowane i przekazywane do bazy.');
    mockUpdateUserCameraProfile.mockResolvedValue({ ...sampleProfile, enabled: false });

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(mockUpdateUserCameraProfile).toHaveBeenCalledWith(1, ALICE_UUID, { enabled: false });
  });

  it('PUT custom/:id updates viewsConfig with per-view icons', async (ctx) => {
    story(ctx, 'User edytuje ikony widoków istniejącego profilu — API przekazuje nową tablicę viewsConfig do bazy.');
    const viewsConfig = [
      { id: '00', iconKind: 'fisheye' },
      { id: '01', iconKind: 'thermal' },
    ];
    mockUpdateUserCameraProfile.mockResolvedValue({ ...sampleProfile, viewsConfig });

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ viewsConfig });
    expect(res.status).toBe(200);
    expect(mockUpdateUserCameraProfile).toHaveBeenCalledWith(1, ALICE_UUID, { viewsConfig });
  });

  it('PUT custom/:id rejects viewsConfig with a bad iconKind (400)', async (ctx) => {
    story(ctx, 'Walidacja iconKind obowiązuje też przy UPDATE — nieznana wartość daje 400 bez zapisu.');
    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ viewsConfig: [{ id: '00', iconKind: 'nope' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/iconKind/i);
    expect(mockUpdateUserCameraProfile).not.toHaveBeenCalled();
  });

  it('PUT custom/:id does not touch views on a name-only update', async (ctx) => {
    story(ctx, 'Aktualizacja tylko nazwy nie powinna nadpisywać widoków — partial-update kontrakt zostaje zachowany.');
    mockUpdateUserCameraProfile.mockResolvedValue({ ...sampleProfile, name: 'Renamed2' });

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ name: 'Renamed2' });
    expect(res.status).toBe(200);
    const callArg = mockUpdateUserCameraProfile.mock.calls[0][2];
    expect(callArg).not.toHaveProperty('viewsConfig');
  });

  // ---------------------------------------------------------------------------
  // DELETE /camera-profiles/custom/:id
  // ---------------------------------------------------------------------------

  it('DELETE custom/:id deletes the profile and returns 204', async (ctx) => {
    story(ctx, 'User usuwa profil — API potwierdza 204 bez ciała odpowiedzi.');
    mockDeleteUserCameraProfile.mockResolvedValue(true);

    const res = await request(app).delete('/api/v0/settings/camera-profiles/custom/1');
    expect(res.status).toBe(204);
    expect(mockDeleteUserCameraProfile).toHaveBeenCalledWith(1, ALICE_UUID);
  });

  it('DELETE custom/:id returns 404 when profile not found', async (ctx) => {
    story(ctx, 'Usunięcie nieistniejącego lub cudzego profilu zwraca 404 — izolacja danych między userami.');
    mockDeleteUserCameraProfile.mockResolvedValue(false);

    const res = await request(app).delete('/api/v0/settings/camera-profiles/custom/999');
    expect(res.status).toBe(404);
  });

  it('DELETE custom/:id returns 400 for non-numeric id', async (ctx) => {
    story(ctx, 'Nienumeryczne ID w URL jest odrzucane z 400.');
    const res = await request(app).delete('/api/v0/settings/camera-profiles/custom/xyz');
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Error handling — DB throws → 500
  // ---------------------------------------------------------------------------

  it('POST custom — db throws → 500 Internal server error', async (ctx) => {
    story(ctx, 'Gdy baza danych rzuca wyjątek przy tworzeniu profilu, API zwraca 500 zamiast crashować.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });
    mockInsertUserCameraProfile.mockRejectedValue(new Error('db error'));

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'My Cam', regex: '^test$' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('PUT custom/:id — db throws → 500 Internal server error', async (ctx) => {
    story(ctx, 'Gdy baza danych rzuca wyjątek przy aktualizacji profilu, API zwraca 500.');
    mockUpdateUserCameraProfile.mockRejectedValue(new Error('db error'));

    const res = await request(app)
      .put('/api/v0/settings/camera-profiles/custom/1')
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('DELETE custom/:id — db throws → 500 Internal server error', async (ctx) => {
    story(ctx, 'Gdy baza danych rzuca wyjątek przy usuwaniu profilu, API zwraca 500.');
    mockDeleteUserCameraProfile.mockRejectedValue(new Error('db error'));

    const res = await request(app).delete('/api/v0/settings/camera-profiles/custom/1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  // ---------------------------------------------------------------------------
  // Input length caps and priority validation
  // ---------------------------------------------------------------------------

  it('POST custom — regex > 500 chars → 400', async (ctx) => {
    story(ctx, 'Regex przekraczający 500 znaków jest odrzucany z 400 — guard przed ogromnym wpisem w bazie.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const longRegex = 'a'.repeat(501);
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'My Cam', regex: longRegex });
    expect(res.status).toBe(400);
  });

  it('POST custom — priority is 1.5 (float) → 400', async (ctx) => {
    story(ctx, 'Niecałkowita wartość priority jest odrzucana z 400 — priorytet musi być integer.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: 'My Cam', regex: '^test$', priority: 1.5 });
    expect(res.status).toBe(400);
  });

  it('POST custom — name > 200 chars → 400', async (ctx) => {
    story(ctx, 'Nazwa profilu przekraczająca 200 znaków jest odrzucana z 400 — guard przed ogromnym wpisem w bazie.');
    mockGetCameraProfileSettings.mockResolvedValue({ mode: 'custom', profiles: [] });

    const longName = 'a'.repeat(201);
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/custom')
      .send({ name: longName, regex: '^test$' });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /camera-profiles/test
  // ---------------------------------------------------------------------------

  it('POST test returns parsed result for a matching filename', async (ctx) => {
    story(ctx, 'User testuje własny regex z przykładową nazwą pliku — API zwraca wyekstrahowane pola.');
    const regex = '^(?<camera>[^_]+)_(?<ts>\\d{14})\\.(?<ext>mp4)$';
    const filename = 'Cam1_20260501120000.mp4';

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex, filename });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      camera: 'Cam1',
      view: '00',
      tsRaw: '20260501120000',
      ext: 'mp4',
    });
  });

  it('POST test includes view from named group when present (canonical)', async (ctx) => {
    story(ctx, 'Regex z grupą (?<view>...) wypełnia pole view w wyniku — user może mapować dual-view kamerę.');
    const regex = '^(?<camera>[^_]+)_(?<view>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$';
    const filename = 'Cam1_01_20260501120000.mp4';

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex, filename });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ camera: 'Cam1', view: '01', tsRaw: '20260501120000', ext: 'mp4' });
  });

  it('POST test accepts legacy (?<lens>...) group for backward compat', async (ctx) => {
    story(ctx, 'Profile authored before v0.10.336 used (?<lens>...) — server still honors it as a synonym for (?<view>...) so saved custom profiles do not break.');
    const regex = '^(?<camera>[^_]+)_(?<lens>00|01)_(?<ts>\\d{14})\\.(?<ext>mp4)$';
    const filename = 'Cam1_01_20260501120000.mp4';

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex, filename });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ camera: 'Cam1', view: '01', tsRaw: '20260501120000', ext: 'mp4' });
  });

  it('POST test returns result:null with reason when regex does not match', async (ctx) => {
    story(ctx, 'Filename, który nie pasuje do regex, powoduje result:null + reason zamiast błędu — user może poprawić regex.');
    const regex = '^(?<camera>[^_]+)_(?<ts>\\d{14})\\.(?<ext>mp4)$';
    const filename = 'totally_different_name.avi';

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex, filename });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: null, reason: 'no match' });
  });

  it('POST test returns 400 for invalid regex syntax', async (ctx) => {
    story(ctx, 'Błędny regex jest odrzucany z 400 i opisem błędu — user widzi co poprawić.');
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex: '(?broken', filename: 'anything.mp4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid regex/i);
  });

  it('POST test returns 400 when required named groups are missing after a match', async (ctx) => {
    story(ctx, 'Regex który matchuje ale nie ma group camera/ts/ext jest odrzucany — user musi dodać wymagane grupy.');
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex: '^(.+)$', filename: 'Cam1_20260501120000.mp4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/named capture groups/i);
  });

  it('POST test returns 400 when ts group does not capture exactly 14 digits', async (ctx) => {
    story(ctx, 'Timestamp który nie jest dokładnie 14 cyfr jest odrzucany — guard przed nieprawidłowym tsRaw w bazie.');
    const regex = '^(?<camera>[^_]+)_(?<ts>\\d{8})\\.(?<ext>mp4)$';
    const filename = 'Cam1_20260501.mp4';

    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex, filename });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/14 digits/i);
  });

  it('POST test accepts the Axis template regex and normalizes its dashed ts to 14 digits', async (ctx) => {
    story(ctx, 'Szablon Axis ma datę z myślnikami (2024-01-15_14-30-22) — endpoint testowy normalizuje ją do 14 cyfr, więc podgląd zgadza się z runtime klasyfikacją.');
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex: AXIS_TEMPLATE.regex, filename: 'Parking_2024-01-15_14-30-22.mp4' });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ camera: 'Parking', tsRaw: '20240115143022', ext: 'mp4' });
  });

  it('POST test accepts the Foscam template regex and normalizes its dashed ts to 14 digits', async (ctx) => {
    story(ctx, 'Szablon Foscam ma znacznik 20240115-143022 — endpoint normalizuje do 14 cyfr i zwraca poprawny tsRaw.');
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex: FOSCAM_TEMPLATE.regex, filename: 'MDAlarm_20240115-143022.mp4' });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ camera: 'MDAlarm', tsRaw: '20240115143022', ext: 'mp4' });
  });

  it('POST test returns 400 for empty regex', async (ctx) => {
    story(ctx, 'Pusty regex jest odrzucany — brak sensu testować puste pole.');
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex: '', filename: 'anything.mp4' });
    expect(res.status).toBe(400);
  });

  it('POST test returns 400 for empty filename', async (ctx) => {
    story(ctx, 'Pusta nazwa pliku jest odrzucana — walidacja input po stronie API.');
    const res = await request(app)
      .post('/api/v0/settings/camera-profiles/test')
      .send({ regex: '^test$', filename: '' });
    expect(res.status).toBe(400);
  });
});

describe('settings router — account timezone', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: 42, isAdmin: false, email: 'alice@test.com', userUuid: ALICE_UUID };
    app = createApp();
  });

  it('GET /timezone returns the user timezone from db', async (ctx) => {
    story(ctx, 'User otwiera General — UI pyta o aktualną strefę i wyświetla ją w wybierałce.');
    mockGetUserTimezone.mockResolvedValue('Europe/Berlin');
    const res = await request(app).get('/api/v0/settings/timezone');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timezone: 'Europe/Berlin' });
    expect(mockGetUserTimezone).toHaveBeenCalledWith(42);
  });

  it('GET /timezone returns 401 when unauthenticated', async () => {
    currentUser = null;
    app = createApp();
    const res = await request(app).get('/api/v0/settings/timezone');
    expect(res.status).toBe(401);
  });

  it('PUT /timezone persists a valid IANA zone', async (ctx) => {
    story(ctx, 'User wybiera nową strefę — UPDATE leci do users.timezone.');
    mockSetUserTimezone.mockResolvedValue(undefined);
    const res = await request(app)
      .put('/api/v0/settings/timezone')
      .send({ timezone: 'America/Los_Angeles' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSetUserTimezone).toHaveBeenCalledWith(42, 'America/Los_Angeles');
  });

  it('PUT /timezone accepts UTC, the default of new accounts', async (ctx) => {
    story(ctx, 'Nowe konto startuje w UTC. Lista stref z Intl (ICU) nie zawiera „UTC”, więc walidator przyjmuje ją jawnie — inaczej po wybraniu innej strefy nie dałoby się do UTC wrócić.');
    mockSetUserTimezone.mockResolvedValue(undefined);
    const res = await request(app).put('/api/v0/settings/timezone').send({ timezone: 'UTC' });
    expect(res.status).toBe(200);
    expect(mockSetUserTimezone).toHaveBeenCalledWith(42, 'UTC');
    // …and it is a zone every formatter understands.
    expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' })).not.toThrow();
  });

  it('PUT /timezone rejects unknown IANA zone with 400', async () => {
    for (const timezone of ['Mars/Olympus_Mons', 'utc', 'UTC ', 'Etc/Nowhere', 'GMT+99']) {
      const res = await request(app)
        .put('/api/v0/settings/timezone')
        .send({ timezone });
      expect(res.status).toBe(400);
    }
    expect(mockSetUserTimezone).not.toHaveBeenCalled();
  });

  it('PUT /timezone rejects missing timezone with 400', async () => {
    const res = await request(app).put('/api/v0/settings/timezone').send({});
    expect(res.status).toBe(400);
    expect(mockSetUserTimezone).not.toHaveBeenCalled();
  });

  it('PUT /timezone returns 401 when unauthenticated', async () => {
    currentUser = null;
    app = createApp();
    const res = await request(app)
      .put('/api/v0/settings/timezone')
      .send({ timezone: 'Europe/Warsaw' });
    expect(res.status).toBe(401);
  });
});
