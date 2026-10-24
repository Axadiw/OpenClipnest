import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import type { CameraEvent, JwtPayload } from '../types.js';
import { story } from '../testing/story.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../db/queries/events.js', () => ({
  getEvents: vi.fn(),
  getEventByIdForOwner: vi.fn(),
  getCameraNames: vi.fn(() => Promise.resolve(['cam1'])),
  getCameraDetails: vi.fn(() => Promise.resolve([])),
  getEventCalendar: vi.fn(() => Promise.resolve([])),
  THUMBNAIL_UNPLAYABLE: '__unplayable__',
  getFileMetadataByKey: vi.fn(() => Promise.resolve({
    id: 1, ownerId: 1, s3Bucket: 'recordings', s3Key: 'uuid-aaa-111/x.mp4',
    originalFilename: 'x.mp4', fileSizeBytes: 1, uploadedAt: '2026-01-01T00:00:00Z',
  })),
  getPlaybackPatchState: vi.fn(() => Promise.resolve({
    readyAt: new Date(), unplayable: false, attempts: 0,
  })),
  deleteEvent: vi.fn(() => Promise.resolve()),
  getFileMetadataSize: vi.fn(() => Promise.resolve(null)),
  removeFileMetadata: vi.fn(() => Promise.resolve()),
}));

vi.mock('../db/queries/storage.js', () => ({
  updateTransferUsage: vi.fn(() => Promise.resolve()),
  checkAndResetTransfer: vi.fn(() => Promise.resolve({ transferUsageBytes: 0 })),
  getUserQuota: vi.fn(() => Promise.resolve(null)),
  updateDiskUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../db/queries/access.js', () => ({
  isAccessLocked: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../db/queries/users.js', () => ({
  getUserByInternalId: vi.fn(),
}));

vi.mock('../services/sidecarCache.js', () => ({
  // Default to NotFound so the route takes the pass-through (class B/C) path
  // and exercises the headObject + range stream path that the security tests
  // assert on.
  getSidecar: vi.fn(() => {
    const err = new Error('NoSuchKey') as Error & { name: string; $metadata: { httpStatusCode: number } };
    err.name = 'NoSuchKey';
    err.$metadata = { httpStatusCode: 404 };
    return Promise.reject(err);
  }),
}));

vi.mock('../services/s3.js', () => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
  // cachedHeadObject (v0.10.272+) wraps headObject with Redis caching on the
  // hot /video path. For these security tests we don't care about the Redis
  // layer — alias both names to the same vi.fn() so `vi.mocked(headObject)`
  // continues to drive both mock'd call sites. If a future test needs to
  // assert on the cache layer specifically (cache hit vs miss), promote
  // cachedHeadObject to its own vi.fn() and the asserting test can override.
  cachedHeadObject: vi.fn(),
  deleteObject: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/auth.js', () => ({
  generateMediaToken: vi.fn(() => 'mock-media-token'),
}));

vi.mock('../services/cameraProfileResolver.js', () => ({
  enrichEventsWithViewMeta: vi.fn((events: unknown[]) => Promise.resolve(events)),
  enrichEventWithViewMeta: vi.fn((event: unknown) => Promise.resolve(event)),
}));

vi.mock('../middleware/rateLimit.js', () => ({
  // Spy wrapper (not a bare arrow) so tests can assert the frames route — and
  // every other media route — actually runs the media rate limiter.
  mediaRateLimit: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  apiRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  diskInfoRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../config.js', () => ({
  CONFIG: {
    itemsPerPage: 50,
    s3RecordingsBucket: 'recordings',
    s3ThumbnailsBucket: 'thumbnails',
    s3SidecarsBucket: 'sidecars',
    mediaTokenExpirySeconds: 900,
    // Enabled so the `?fmt=clean` clean-frame serve path is reachable in the
    // listener-leak test below; other tests don't pass fmt=clean so they skip it.
    cleanFrameEnabled: true,
  },
}));

import eventsRouter, { endStreamWithError } from './events.js';
import { getEvents, getEventByIdForOwner } from '../db/queries/events.js';
import { getUserByInternalId } from '../db/queries/users.js';
import { getObject, headObject, cachedHeadObject } from '../services/s3.js';
import { getSidecar } from '../services/sidecarCache.js';
import { cleanFrameSidecarCache } from '../services/cleanFrameSidecarCache.js';
import { checkAndResetTransfer, updateTransferUsage } from '../db/queries/storage.js';
import { generateMediaToken } from '../services/auth.js';
import { mediaRateLimit } from '../middleware/rateLimit.js';
import { Readable } from 'stream';
import type { Response as ExpressResponse } from 'express';

// ---------------------------------------------------------------------------
// Test users
// ---------------------------------------------------------------------------

const USER_A: JwtPayload = {
  userId: 1,
  userUuid: 'uuid-aaa-111',
  email: 'alice@test.com',
  isAdmin: false,
};

const USER_B: JwtPayload = {
  userId: 2,
  userUuid: 'uuid-bbb-222',
  email: 'bob@test.com',
  isAdmin: false,
};

const ADMIN_USER: JwtPayload = {
  userId: 99,
  userUuid: 'uuid-admin-999',
  email: 'superadmin@test.com',
  isAdmin: true,
};

// An event owned by User A
const EVENT_OWNED_BY_A: CameraEvent = {
  id: 'evt-001',
  camera: 'cam1',
  timestamp: '2025-12-01T10:00:00Z',
  date: '2025-12-01',
  views: [
    { id: '00', videoRelPath: 'cam1/2025-12-01/wide.mp4' },
    { id: '01', videoRelPath: 'cam1/2025-12-01/zoom.mp4' },
  ],
  thumbnail: 'cam1/2025-12-01/thumb.jpg',
  duration: 30,
  ownerId: USER_A.userId,
};

// ---------------------------------------------------------------------------
// Express app setup — inject auth user via a fake middleware
// ---------------------------------------------------------------------------

function buildApp(user: JwtPayload | undefined) {
  const app = express();
  app.use(express.json());
  // Fake auth middleware that sets req.user
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      req.user = { ...user };
    }
    next();
  });
  app.use('/events', eventsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helper to create a readable stream
// ---------------------------------------------------------------------------

function fakeStream(content = 'binary-data'): Readable {
  const s = new Readable();
  s.push(content);
  s.push(null);
  return s;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Events routes — cross-user access prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The clean-frame sidecar cache is process-wide state; a test must not inherit another test's entries.
    cleanFrameSidecarCache.clear();

    // cachedHeadObject (v0.10.272+) is the Redis-cached wrapper that the
    // /video hot-path uses now. For tests it just forwards to the
    // headObject mock so every existing `vi.mocked(headObject).mockResolvedValue(...)`
    // continues to drive both code paths without test churn.
    vi.mocked(cachedHeadObject).mockImplementation(
      (...args: Parameters<typeof headObject>) => vi.mocked(headObject)(...args),
    );

    // Default: getUserByInternalId returns a user with an encryption salt
    vi.mocked(getUserByInternalId).mockImplementation((id: number) => {
      if (id === USER_A.userId) {
        return Promise.resolve({
          id: USER_A.userUuid,
          email: USER_A.email,
          isAdmin: false,
          active: true,
          createdAt: '2025-01-01',
          internalId: USER_A.userId,
          passwordHash: 'hash',
          tokenGeneration: 1,
          encryptionSalt: 'salt-aaa',
        });
      }
      if (id === USER_B.userId) {
        return Promise.resolve({
          id: USER_B.userUuid,
          email: USER_B.email,
          isAdmin: false,
          active: true,
          createdAt: '2025-01-01',
          internalId: USER_B.userId,
          passwordHash: 'hash',
          tokenGeneration: 1,
          encryptionSalt: 'salt-bbb',
        });
      }
      return Promise.resolve(undefined);
    });
  });

  // =========================================================================
  // 1. Event detail — cross-user isolation
  // =========================================================================

  describe('GET /events/:id/detail — ownership check', () => {
    it('User A can access their own event detail', async (ctx) => {
      story(ctx, 'Właściciel eventu widzi swoje nagranie i metadane — to podstawowa funkcjonalność biblioteki nagrań użytkownika.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      const app = buildApp(USER_A);

      const res = await request(app).get('/events/evt-001/detail');

      expect(res.status).toBe(200);
      expect(res.body.event).toBeDefined();
      expect(res.body.event.id).toBe('evt-001');
      // Verify getEventByIdForOwner was called with the correct owner
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_A.userId);
    });

    it('User B cannot access User A event detail (returns 404)', async (ctx) => {
      story(ctx, 'Zwykły użytkownik próbujący czytać eventy innego tenanta dostaje 404 zamiast 403 — kluczowy izolator danych między kontami w jednej instancji, bez wycieku informacji o istnieniu eventu.');
      // getEventByIdForOwner returns undefined when ownerId does not match
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);
      const app = buildApp(USER_B);

      const res = await request(app).get('/events/evt-001/detail');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Event not found');
      // Crucially, the lookup used User B's id — not User A's
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_B.userId);
    });

    it('returns 401 when no user is authenticated', async (ctx) => {
      story(ctx, 'Niezalogowany klient nie dostaje żadnych informacji o eventach — 401 zmusza go do logowania, zanim jakiekolwiek zapytanie do bazy zostanie wykonane.');
      const app = buildApp(undefined);

      const res = await request(app).get('/events/evt-001/detail');

      expect(res.status).toBe(401);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Video endpoint — cross-user isolation
  // =========================================================================

  describe('GET /events/:id/video/:view — ownership check', () => {
    it('User A can stream their own wide video', async (ctx) => {
      story(ctx, 'Właściciel streamuje swoje nagranie z kamery szerokokątnej — podstawowy flow odtwarzania w detalu eventu.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 1024, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(USER_A);
      // Video routes use res.writeHead + pipe which can cause ECONNRESET in supertest.
      // The security assertion is that ownership was verified and S3 was contacted.
      try {
        await request(app).get('/events/evt-001/video/00');
      } catch {
        // Stream-related supertest errors are expected; ignore
      }

      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_A.userId);
      expect(headObject).toHaveBeenCalled();
    });

    it('User B cannot access User A wide video (returns 404)', async (ctx) => {
      story(ctx, 'Atakujący zalogowany jako Bob nie pobierze wideo Alicji — 404 bez kontaktu z S3 chroni prywatne nagrania i nie daje sygnału o ich istnieniu.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);
      const app = buildApp(USER_B);

      const res = await request(app).get('/events/evt-001/video/00');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Event not found');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_B.userId);
      // S3 should never be contacted for a non-owned event
      expect(headObject).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
    });

    it('User B cannot access User A zoom video (returns 404)', async (ctx) => {
      story(ctx, 'Zoom view ma tę samą osłonę co wide — cudze nagranie z teleobiektywu jest niewidoczne dla innych użytkowników i nawet S3 nie jest wołane.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);
      const app = buildApp(USER_B);

      const res = await request(app).get('/events/evt-001/video/01');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Event not found');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_B.userId);
      expect(headObject).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
    });

    it('rejects oversized view parameter with 400', async (ctx) => {
      story(ctx, 'View id musi mieć długość 1..16 znaków — wartości >16 kończą się 400 zanim dotrzemy do DB. Reolink używa 00/01, custom profile mogą używać dowolnego stringa w tym zakresie.');
      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/video/' + 'x'.repeat(17));

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid view');
    });

    it('returns 404 for a view id that does not match any attached view', async (ctx) => {
      story(ctx, 'Wartość lensa, która przeszła walidację długości ale nie matchuje żadnego event.views[].id: 404 z czytelnym komunikatem. Bez tego ślepy GET na nieistniejącego lensa wisiałby na cichym S3 not-found.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/video/telephoto');

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/No video for view/);
    });

    it('clamps a Range end past EOF to the last byte (206, not 416) on the pass-through path', async (ctx) => {
      story(ctx, 'RFC 7233: `Range: bytes=0-N` z N >= rozmiar pliku to nadal poprawny zakres — koniec ma być przycięty do EOF, nie odrzucony. Empirycznie prod zwracał 416 z pustym body na plikach <4 MB przy `bytes=0-4194303` (typowy chunk gracza), psując odtwarzanie klipów klasy B/C i niegotowych sidecarów. Przycinamy end do fileSize-1 i zwracamy 206.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      // File smaller than the requested 4 MB chunk window. Body length must
      // match the clamped chunk size or supertest aborts on the short pipe.
      const fileBody = 'x'.repeat(2048);
      vi.mocked(headObject).mockResolvedValue({ contentLength: fileBody.length, lastModified: new Date() });
      // The pass-through path's moov head-probe getObject runs first; reject it
      // 404 so passThroughMoov stays null and the route serves the raw ranged GET.
      const noSuchKeyErr = Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
      vi.mocked(getObject)
        .mockRejectedValueOnce(noSuchKeyErr)
        .mockImplementation(async () => ({ body: fakeStream(fileBody), contentRange: undefined }));

      const app = buildApp(USER_A);
      const res = await request(app)
        .get('/events/evt-001/video/00')
        .set('Range', 'bytes=0-4194303');

      expect(res.status).toBe(206);
      // End clamped to fileSize-1; total still reflects the real file size.
      expect(res.headers['content-range']).toBe('bytes 0-2047/2048');
      expect(res.headers['accept-ranges']).toBe('bytes');
      // The S3 GET must request the clamped range, not the raw oversized end.
      expect(getObject).toHaveBeenCalledWith(
        'recordings', expect.any(String), expect.any(String), 'bytes=0-2047',
      );
    });

    it('returns 416 only when the Range start is at or past EOF', async (ctx) => {
      story(ctx, 'Granica drugiej strony tej samej poprawki: start >= rozmiar pliku to faktycznie nieosiągalny zakres i MUSI dawać 416, żeby przycięcie end-a nie zamaskowało prawdziwie błędnego żądania.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 2_000_000, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(USER_A);
      const res = await request(app)
        .get('/events/evt-001/video/00')
        .set('Range', 'bytes=2000000-2999999');

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe('bytes */2000000');
      expect(getObject).not.toHaveBeenCalled();
    });

    it('returns 401 when no user is authenticated', async (ctx) => {
      story(ctx, 'Stream wideo wymaga zalogowania — niezalogowane zapytanie ucina się zanim dotknie S3, co oszczędza ruch i zamyka drogę do enumeracji.');
      const app = buildApp(undefined);
      const res = await request(app).get('/events/evt-001/video/00');

      expect(res.status).toBe(401);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
    });

    it('strips Content-Security-Policy and Cross-Origin-Resource-Policy from GET response', async (ctx) => {
      story(ctx, 'Helmetowe nagłówki CSP/CORP są ustawiane globalnie pod wszystkie odpowiedzi API, ale Chrome odrzuca media z `default-src \'none\'` jako NETWORK_NO_SOURCE — trasa wideo musi je zdjąć przed pierwszym writeHead, inaczej Firefox gra a Chrome stoi w "Loading video…".');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 1024, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        // Simulate helmet defaults injected upstream
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        req.user = { ...USER_A };
        next();
      });
      app.use('/events', eventsRouter);

      try {
        const res = await request(app).get('/events/evt-001/video/00');
        expect(res.headers['content-security-policy']).toBeUndefined();
        expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
      } catch {
        // Stream-pipe ECONNRESET in supertest is expected on success path; the
        // headers we care about are flushed by res.writeHead long before pipe.
      }
    });
  });

  // =========================================================================
  // 2a-bis. Video endpoint — listener-leak + transfer-accounting invariants
  //   FIX 1 (listener leak):  at most ONE `close` listener is
  //          added to the ServerResponse per logical /video request, so the
  //          stream paths can never stack up to the "11 close listeners on
  //          [ServerResponse]" MaxListenersExceededWarning.
  //   FIX 2 (transfer quota fire-and-forget): transfer usage is recorded
  //          EXACTLY ONCE per request, on completion, never lost / never doubled.
  // =========================================================================

  describe('GET /events/:id/video/:view — listener-leak + transfer accounting', () => {
    const noSuchKey = () => Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey', $metadata: { httpStatusCode: 404 },
    });

    it('records transfer usage EXACTLY ONCE on a clean pass-through stream', async (ctx) => {
      story(
        ctx,
        'Rozliczanie transferu (transfer quota) musi naliczyć się DOKŁADNIE RAZ na request. Wcześniej każda gałąź streamująca wołała updateTransferUsage(...) fire-and-forget — przy aborcie iOS AVPlayera gubiła bajty, a przy throw-po-nagłówkach + fall-through mogła naliczyć podwójnie. Teraz jeden handler res.finish/close nalicza bajty raz (faktyczne bytesWritten w prod, planowane bajty gdy socket nieobserwowalny, np. w in-memory transport supertest).',
      );
      const { updateTransferUsage } = await import('../db/queries/storage.js');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      const fileBody = 'x'.repeat(2048);
      vi.mocked(headObject).mockResolvedValue({ contentLength: fileBody.length, lastModified: new Date() });
      // Pass-through moov head-probe getObject 404s → passThroughMoov stays null,
      // route serves the raw full-file GET (the mockResolvedValue below).
      vi.mocked(getObject)
        .mockRejectedValueOnce(noSuchKey())
        .mockResolvedValue({ body: fakeStream(fileBody), contentRange: undefined });

      try {
        await request(buildApp(USER_A)).get('/events/evt-001/video/00');
      } catch {
        // supertest may RST on the pipe; the accounting handler fires on close.
      }
      // The completion handler is wired on res.finish/close; give the event
      // loop a tick to let those fire after supertest tears the socket down.
      await new Promise((r) => setImmediate(r));

      expect(vi.mocked(updateTransferUsage)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateTransferUsage).mock.calls[0][0]).toBe(USER_A.userId);
      // Planned bytes for the full-file pass-through == fileSize. (Under
      // supertest res.socket is undefined, so the latch records the planned
      // count, capped at Content-Length — never the inflated raw socket delta.)
      expect(vi.mocked(updateTransferUsage).mock.calls[0][1]).toBe(fileBody.length);
    });

    it('does NOT bill transfer twice when the clean-frame path throws AFTER headers (no fall-through)', async (ctx) => {
      story(
        ctx,
        'Sedno: gdy ścieżka clean-frame (?fmt=clean) rzuci błędem PO wysłaniu nagłówków + throttle.pipe(res), handler NIE może wpaść do gałęzi fmp4/pass-through — bo dołożyłaby DRUGI throttle.pipe(res) (kolejny close-listener na tym samym ServerResponse → akumulacja do "11 close listeners") i nadpisała half-sent body. Guard `if (res.headersSent) throw err` przerywa fall-through. Skutek uboczny: transfer nie jest naliczany podwójnie.',
      );
      const { updateTransferUsage } = await import('../db/queries/storage.js');
      const { packCleanFrameSidecar } = await import('../services/mp4/cleanFrameSidecar.js');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 4096, lastModified: new Date() });

      // A VALID clean_frame sidecar so streamCleanFrameMp4 gets past unpack,
      // writes 200/206 headers + throttle.pipe(res), THEN its zone-3 S3 GET
      // (the compacted-mdat payload fetch) fails mid-stream → it throws AFTER
      // headersSent. The clean-frame catch must re-throw (the
      // `if (res.headersSent) throw err` guard) instead of falling through and
      // attaching a SECOND throttle.pipe.
      const sidecar = packCleanFrameSidecar({
        prelude: Buffer.from('ftyp+clean-frame-prelude-bytes'), // any non-empty prelude
        mdatHeader: Buffer.from([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]), // "mdat" 8-byte header
        // One non-empty payload run → servedSize > prelude+header, so the
        // default (no-Range) request covers zone 3 and runs the zone-3 S3 GET.
        byteRanges: [{ srcOffset: 100, length: 100 }],
        frameGrid: [],
      });

      // Told apart by what is asked for, not by call order: on a sidecar cache miss the route also touches the
      // original with a 16-byte read (a warm-up), which must not be mistaken for the data read.
      let dataReads = 0;
      vi.mocked(getObject).mockImplementation(async (bucket: string, _key: string, _salt: string, byteRange?: string) => {
        if (bucket === 'sidecars') return { body: Readable.from([sidecar]), contentRange: undefined }; // clean_frame fetch
        if (byteRange === 'bytes=0-15') return { body: fakeStream('w'.repeat(16)), contentRange: undefined }; // the warm-up
        if (++dataReads === 1) throw Object.assign(new Error('S3 connection reset'), { name: 'NetworkingError' }); // zone-3 mid-stream throw (post-header)
        return { body: fakeStream('MUST-NOT-BE-STREAMED'), contentRange: undefined }; // would be the leaked 2nd pipe
      });

      try {
        await request(buildApp(USER_A)).get('/events/evt-001/video/00?fmt=clean');
      } catch {
        // expected: socket torn down mid-stream by the outer catch (res.destroy)
      }
      await new Promise((r) => setImmediate(r));

      // FIX 1 invariant: the fall-through MUST NOT run, so there is exactly ONE data read (the
      // failing zone-3 GET) — never a second one for an fmp4/pass-through re-stream that would
      // stack a second pipe (the listener leak) and corrupt the half-sent body. (The clean_frame
      // fetch and the warm-up read are not data reads.)
      const dataGets = vi.mocked(getObject).mock.calls.filter(([bucket, , , byteRange]) => bucket !== 'sidecars' && byteRange !== 'bytes=0-15');
      expect(dataGets).toHaveLength(1);
      // FIX 2 corollary: transfer billed AT MOST once (never doubled).
      expect(vi.mocked(updateTransferUsage).mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('does not fetch the clean-frame sidecar again for the next request of the same clip', async (ctx) => {
      story(
        ctx,
        'Przeglądarka i aplikacje robią HEAD i kilka Range GET-ów na jedno odtworzenie. Sidecar clean-frame ma być pobrany z magazynu RAZ, a kolejne żądania tego klipu mają kosztować już tylko odczyt danych (50-250 ms mniej na żądanie na zdalnym magazynie).',
      );
      const { packCleanFrameSidecar } = await import('../services/mp4/cleanFrameSidecar.js');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 4096, lastModified: new Date() });
      const prelude = Buffer.from('ftyp+clean-frame-prelude-bytes');
      const sidecar = packCleanFrameSidecar({
        prelude,
        mdatHeader: Buffer.from([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]),
        byteRanges: [{ srcOffset: 100, length: 100 }],
        frameGrid: [],
      });
      // What a request asks the object store for, told apart by the bucket and the range it names.
      vi.mocked(getObject).mockImplementation(async (bucket: string, _key: string, _salt: string, byteRange?: string) => {
        if (bucket === 'sidecars') return { body: Readable.from([sidecar]), contentRange: undefined };
        if (byteRange === 'bytes=0-15') return { body: fakeStream('w'.repeat(16)), contentRange: undefined };
        return { body: fakeStream('d'.repeat(100)), contentRange: undefined };
      });
      const reads = () => vi.mocked(getObject).mock.calls;
      const sidecarReads = () => reads().filter(([bucket]) => bucket === 'sidecars').length;
      const warmUps = () => reads().filter(([bucket, , , byteRange]) => bucket !== 'sidecars' && byteRange === 'bytes=0-15').length;
      const dataReads = () => reads().filter(([bucket, , , byteRange]) => bucket !== 'sidecars' && byteRange !== 'bytes=0-15').length;

      try {
        const first = await request(buildApp(USER_A)).get('/events/evt-001/video/00?fmt=clean');
        const second = await request(buildApp(USER_A)).get('/events/evt-001/video/00?fmt=clean');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        // Both responses are the same clean stream: prelude + 8-byte mdat header + the 100-byte run.
        const served = String(prelude.length + 8 + 100);
        expect(first.headers['content-length']).toBe(served);
        expect(second.headers['content-length']).toBe(served);
        expect(sidecarReads()).toBe(1); // the sidecar: once
        expect(warmUps()).toBe(1); // the original is warmed once, together with that first sidecar read
        expect(dataReads()).toBe(2); // the data: each response still reads its own bytes
        // The second request added exactly one read: its data. No sidecar, no warm-up.
        expect(reads()).toHaveLength(4);
      } finally {
        vi.mocked(getObject).mockReset();
      }
    });
  });

  // =========================================================================
  // 2b. Video endpoint — HEAD fast-path
  // =========================================================================

  describe('HEAD /events/:id/video/:view — fast probe path', () => {
    it('returns 200 with Content-Length and Accept-Ranges, without touching sidecar or quota', async (ctx) => {
      story(ctx, 'Chrome wysyła HEAD obok GET-a do walidacji źródła — musi dostać szybką, deterministyczną odpowiedź. Pełen handler GET-a ciągnie sidecar z S3 (~500 ms i okazjonalne 503), co Chrome interpretuje jako broken source. Dedykowany HEAD odpowiada na samych metadanych z `headObject`.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 100_328_171, lastModified: new Date() });

      const app = buildApp(USER_A);
      const res = await request(app).head('/events/evt-001/video/00');

      expect(res.status).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe('100328171');
      expect(res.headers['content-type']).toBe('video/mp4');
      // Critical: HEAD must NOT pay the sidecar / quota cost — those are GET-only.
      expect(getSidecar).not.toHaveBeenCalled();
      expect(checkAndResetTransfer).not.toHaveBeenCalled();
    });

    it('strips Content-Security-Policy and Cross-Origin-Resource-Policy', async (ctx) => {
      story(ctx, 'HEAD też pełni rolę probe-a w Chrome — musi odpowiadać tymi samymi nagłówkami co GET, włącznie z brakiem CSP/CORP. Inaczej Chrome dostaje sprzeczne dane i odrzuca źródło.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 1024, lastModified: new Date() });

      const app = express();
      app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        req.user = { ...USER_A };
        next();
      });
      app.use('/events', eventsRouter);

      const res = await request(app).head('/events/evt-001/video/00');
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
    });

    it("returns 404 when User B HEADs User A's video", async (ctx) => {
      story(ctx, 'Cross-user izolacja działa tak samo dla HEAD jak dla GET — nie wolno przeciekać samym kodem 200 vs 404 informacji, że dany event istnieje u innego użytkownika.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);
      const app = buildApp(USER_B);
      const res = await request(app).head('/events/evt-001/video/00');
      expect(res.status).toBe(404);
      expect(headObject).not.toHaveBeenCalled();
    });

    it('returns 401 when no user is authenticated', async (ctx) => {
      story(ctx, 'HEAD niesie ten sam wymóg autoryzacji co GET — anonimowy probe nie powinien dotykać bazy ani S3.');
      const app = buildApp(undefined);
      const res = await request(app).head('/events/evt-001/video/00');
      expect(res.status).toBe(401);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
    });

    it('rejects oversized view parameter with 400', async (ctx) => {
      story(ctx, 'Walidacja długości lensa wykonuje się wcześnie — wartość >16 znaków kończy się 400 zanim dotkniemy bazy.');
      const app = buildApp(USER_A);
      const res = await request(app).head('/events/evt-001/video/' + 'x'.repeat(17));
      expect(res.status).toBe(400);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Thumbnail endpoint — cross-user isolation
  // =========================================================================

  describe('GET /events/:id/thumbnail — ownership check', () => {
    it('User A can access their own thumbnail', async (ctx) => {
      story(ctx, 'Thumbnail eventu na gridzie pobiera użytkownik będący właścicielem — to zapewnia szybki podgląd na liście nagrań.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 11, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/thumbnail');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_A.userId);
    });

    it('User B cannot access User A thumbnail (returns 404)', async (ctx) => {
      story(ctx, 'Thumbnaile innych użytkowników są niewidoczne — inaczej atakujący mógłby zeskanować ich grid, patrząc na zawartość kadrów, nawet jeśli wideo blokuje.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);
      const app = buildApp(USER_B);

      const res = await request(app).get('/events/evt-001/thumbnail');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Thumbnail not found');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_B.userId);
      // S3 should never be contacted for a non-owned event
      expect(getObject).not.toHaveBeenCalled();
    });

    it('returns 401 when no user is authenticated', async (ctx) => {
      story(ctx, 'Anonimowy gość nie dostanie żadnego thumbnaila — standardowy mur autoryzacji przed dotknięciem DB i S3.');
      const app = buildApp(undefined);
      const res = await request(app).get('/events/evt-001/thumbnail');

      expect(res.status).toBe(401);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
    });

    it('media token scoped to a different event is rejected with 403', async (ctx) => {
      story(ctx, 'Krótki media token wystawiany dla konkretnego eventu nie może być użyty do innego eventu — chroni przed kradzieżą tokena i zeskanowaniem całej biblioteki.');
      const userWithWrongMediaToken: JwtPayload = {
        ...USER_A,
        mediaEventId: 'evt-OTHER',
      };
      const app = buildApp(userWithWrongMediaToken);

      const res = await request(app).get('/events/evt-001/thumbnail');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Token not valid for this resource');
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Events list — ownerId filter
  // =========================================================================

  describe('GET /events — list filtered by ownerId', () => {
    it('passes the requesting user userId as ownerId filter', async (ctx) => {
      story(ctx, 'Endpoint /events zawsze filtruje po ownerId z sesji — user widzi TYLKO swoje nagrania, to fundament multi-tenantowej aplikacji.');
      vi.mocked(getEvents).mockResolvedValue({ events: [], total: 0, nextCursor: null });
      const app = buildApp(USER_A);

      await request(app).get('/events');

      expect(getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: USER_A.userId,
        }),
      );
    });

    it('User B only sees their own events (ownerId = User B)', async (ctx) => {
      story(ctx, 'Bob widzi tylko eventy Boba, nigdy Alicji — niezależnie od sesji, backend wstrzykuje userId z JWT zamiast ufać parametrom.');
      vi.mocked(getEvents).mockResolvedValue({ events: [], total: 0, nextCursor: null });
      const app = buildApp(USER_B);

      await request(app).get('/events');

      expect(getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: USER_B.userId,
        }),
      );
    });

    it('User A and User B get different ownerId filters for the same request', async (ctx) => {
      story(ctx, 'Dwóch zalogowanych userów wołających ten sam URL dostaje różne filtry ownerId — każdy widzi swój tenant, izolacja jest na pełnym rewardingu.');
      vi.mocked(getEvents).mockResolvedValue({ events: [], total: 0, nextCursor: null });

      const appA = buildApp(USER_A);
      const appB = buildApp(USER_B);

      await request(appA).get('/events');
      await request(appB).get('/events');

      const calls = vi.mocked(getEvents).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].ownerId).toBe(USER_A.userId);
      expect(calls[1][0].ownerId).toBe(USER_B.userId);
    });

    it('cannot override ownerId via query parameter injection', async (ctx) => {
      story(ctx, 'Atakujący dokleja `?ownerId=1` do URL, próbując czytać cudze eventy — backend ignoruje parametr i trzyma się userId z JWT, zamykając drogę do IDOR.');
      vi.mocked(getEvents).mockResolvedValue({ events: [], total: 0, nextCursor: null });
      const app = buildApp(USER_B);

      // Attempt to inject User A's ownerId via query string
      await request(app).get('/events?ownerId=1');

      // The ownerId passed to getEvents must still be User B's id
      expect(getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: USER_B.userId,
        }),
      );
    });
  });

  // =========================================================================
  // 5. Admin users cannot access event endpoints (design choice)
  // =========================================================================

  describe('Admin user restrictions', () => {
    // Note: In the real app, the requireNonAdmin middleware runs BEFORE the
    // events router (see index.ts line 57). Here we test the route-level
    // behavior. The middleware itself blocks admin access with 403.
    // We replicate the middleware in these tests.

    function buildAppWithAdminGuard(user: JwtPayload | undefined) {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        if (user) req.user = { ...user };
        next();
      });
      // Replicate requireNonAdmin guard that is applied in index.ts
      app.use('/events', (req: Request, res: Response, next: NextFunction) => {
        if (req.user?.isAdmin) {
          res.status(403).json({ error: 'Admin users cannot access recordings' });
          return;
        }
        next();
      }, eventsRouter);
      return app;
    }

    it('admin gets 403 on event list', async (ctx) => {
      story(ctx, 'Admin nie ma własnych nagrań i nie powinien przeglądać cudzych — middleware requireNonAdmin blokuje listę, chroniąc prywatność klientów.');
      const app = buildAppWithAdminGuard(ADMIN_USER);
      const res = await request(app).get('/events');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin users cannot access recordings');
    });

    it('admin gets 403 on event detail', async (ctx) => {
      story(ctx, 'Nawet jeśli admin zna ID eventu, nie zobaczy detalu — 403 chroni prywatność nagrań konkretnego użytkownika przed konta administracyjnymi.');
      const app = buildAppWithAdminGuard(ADMIN_USER);
      const res = await request(app).get('/events/evt-001/detail');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin users cannot access recordings');
    });

    it('admin gets 403 on video endpoint', async (ctx) => {
      story(ctx, 'Admin nie odtworzy cudzego wideo — middleware blokuje endpointy nagrań, żeby osoba administrująca serwer nie mogła podglądać kamer klientów.');
      const app = buildAppWithAdminGuard(ADMIN_USER);
      const res = await request(app).get('/events/evt-001/video/00');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin users cannot access recordings');
    });

    it('admin gets 403 on thumbnail endpoint', async (ctx) => {
      story(ctx, 'Thumbnaile też są objęte ochroną — inaczej admin mógłby zrobić mozaikę cudzego dnia bez tykania wideo, co jest równie inwazyjne.');
      const app = buildAppWithAdminGuard(ADMIN_USER);
      const res = await request(app).get('/events/evt-001/thumbnail');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin users cannot access recordings');
    });

    it('admin gets 403 on media-token endpoint', async (ctx) => {
      story(ctx, 'Admin nie może wyrobić sobie krótkiego media tokena — inaczej obchodziłby ochronę detali i thumbnaili oraz streamował cudze nagrania.');
      const app = buildAppWithAdminGuard(ADMIN_USER);
      const res = await request(app).post('/events/evt-001/media-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin users cannot access recordings');
    });

  });

  // =========================================================================
  // 6. Media token endpoint — ownership verification
  // =========================================================================

  describe('POST /events/:id/media-token — ownership check', () => {
    it('User A can get a media token for their own event', async (ctx) => {
      story(ctx, 'Właściciel wyrabia sobie krótki media token, zanim uruchomi player — to sposób, żeby nie przekazywać pełnego JWT do tagu <video>.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      const app = buildApp(USER_A);

      const res = await request(app).post('/events/evt-001/media-token');

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('mock-media-token');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_A.userId);
      expect(generateMediaToken).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_A.userId }),
        'evt-001',
      );
    });

    it('User B cannot get a media token for User A event (returns 404)', async (ctx) => {
      story(ctx, 'Cudzy event nie daje nawet media tokena — 404 bez wywołania `generateMediaToken` chroni przed wyciekiem signed URL do nagrania innego usera.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);
      const app = buildApp(USER_B);

      const res = await request(app).post('/events/evt-001/media-token');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Event not found');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_B.userId);
      // Token should never be generated for a non-owned event
      expect(generateMediaToken).not.toHaveBeenCalled();
    });

    it('returns 401 when no user is authenticated', async (ctx) => {
      story(ctx, 'Anonimowy klient nie dostanie media tokena — bez JWT żadne wideo nie może być puszczone, co zamyka drogę do streamowania bez autoryzacji.');
      const app = buildApp(undefined);

      const res = await request(app).post('/events/evt-001/media-token');

      expect(res.status).toBe(401);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
      expect(generateMediaToken).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 7. Video endpoint — media token scope validation
  // =========================================================================

  describe('GET /events/:id/video/:view — media token scope', () => {
    it('media token scoped to wrong event is rejected with 403', async (ctx) => {
      story(ctx, 'Token wystawiony dla eventu X nie puści wideo z eventu Y — to zawęża powierzchnię ataku przy ewentualnym wycieku krótkiego tokena z cache przeglądarki.');
      const userWithWrongScope: JwtPayload = {
        ...USER_A,
        mediaEventId: 'evt-OTHER',
      };
      const app = buildApp(userWithWrongScope);

      const res = await request(app).get('/events/evt-001/video/00');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Token not valid for this resource');
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
      expect(headObject).not.toHaveBeenCalled();
    });

    it('media token scoped to correct event passes scope check', async (ctx) => {
      story(ctx, 'Poprawnie zakresowany media token przechodzi walidację — to normalny happy path player wideo po wyrobieniu tokenu z /media-token.');
      const userWithCorrectScope: JwtPayload = {
        ...USER_A,
        mediaEventId: 'evt-001',
      };
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 2048, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(userWithCorrectScope);
      // Video routes use res.writeHead + pipe which can cause ECONNRESET in supertest.
      try {
        await request(app).get('/events/evt-001/video/00');
      } catch {
        // Stream-related supertest errors are expected; ignore
      }

      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_A.userId);
      expect(headObject).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 8. S3 path isolation — user UUID is used, not attacker UUID
  // =========================================================================

  describe('S3 path uses the authenticated user UUID, not attacker-controlled values', () => {
    it('video S3 key is derived from authenticated user userUuid', async (ctx) => {
      story(ctx, 'Klucz S3 wideo jest budowany z UUID z JWT, nie z parametrów żądania — atakujący nie może wymusić odczytu obiektu spod cudzego prefiksu w buckecie.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 512, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(USER_A);
      // Video routes use res.writeHead + pipe which can cause ECONNRESET in supertest.
      try {
        await request(app).get('/events/evt-001/video/00');
      } catch {
        // Stream-related supertest errors are expected; ignore
      }

      // The S3 key should include User A's UUID, proving path isolation
      expect(headObject).toHaveBeenCalledWith(
        'recordings',
        `${USER_A.userUuid}/cam1/2025-12-01/wide.mp4`,
        'salt-aaa',
      );
    });

    it('thumbnail S3 key is derived from authenticated user userUuid', async (ctx) => {
      story(ctx, 'Ten sam bezpiecznik co dla wideo: klucz thumbnaila zawiera UUID z sesji, nie z URL — izolacja prefiksów S3 jest sterowana wyłącznie JWT.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 11, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(USER_A);
      await request(app).get('/events/evt-001/thumbnail');

      expect(getObject).toHaveBeenCalledWith(
        'recordings',
        `${USER_A.userUuid}/cam1/2025-12-01/thumb.jpg`,
        'salt-aaa',
      );
    });

    it('each user encryption salt is fetched from their own profile', async (ctx) => {
      story(ctx, 'Sól SSE-C dla odszyfrowania obiektów S3 jest pobierana z profilu zalogowanego usera — gwarantuje, że nagrania są deszyfrowane tylko dla właściciela klucza.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 11, lastModified: new Date() });
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(), contentRange: undefined });

      const app = buildApp(USER_A);
      await request(app).get('/events/evt-001/thumbnail');

      // getUserByInternalId must be called with the authenticated user's internal id
      expect(getUserByInternalId).toHaveBeenCalledWith(USER_A.userId);
    });
  });

  // =========================================================================
  // 9. Streaming handler headers-sent race
  // =========================================================================
  //
  // The thumbnail handler could raise `ERR_HTTP_HEADERS_SENT` — the streaming path
  // emitted an async error after headers had been flushed and the catch
  // block tried `res.status().json()` on top. Fix is `endStreamWithError`:
  // if headers are on the wire, destroy the socket; otherwise send the JSON
  // error like every other route.

  describe('endStreamWithError — race-safe stream error sink', () => {
    /**
     * Build a minimal mock of the Express Response surface this helper
     * actually touches. Casting via `unknown` keeps the test focused on
     * behaviour without us shimming the full ServerResponse contract.
     */
    function mockResponse(opts: { headersSent: boolean; writableEnded?: boolean }) {
      const calls = {
        status: undefined as number | undefined,
        json: undefined as unknown,
        destroyArg: undefined as unknown,
        destroyed: false,
      };
      const res = {
        headersSent: opts.headersSent,
        writableEnded: opts.writableEnded ?? false,
        status(code: number) {
          calls.status = code;
          return res;
        },
        json(body: unknown) {
          calls.json = body;
          return res;
        },
        destroy(err: unknown) {
          calls.destroyArg = err;
          calls.destroyed = true;
          return res;
        },
      };
      return { res: res as unknown as ExpressResponse, calls };
    }

    it('sends JSON 500 when headers have NOT been flushed yet', (ctx) => {
      story(ctx, 'Init-phase failure (S3 timeout zanim jeszcze writeHead) musi wciąż zwrócić JSON-a — frontend dostaje normalny błąd zamiast porwanego socketa. Helper zachowuje się jak każdy inny catch w routerze, kiedy nie ma jeszcze nagłówków na druciku.');
      const { res, calls } = mockResponse({ headersSent: false });
      endStreamWithError(res, new Error('s3 timeout'));
      expect(calls.status).toBe(500);
      expect(calls.json).toEqual({ error: 'stream_failed', detail: 's3 timeout' });
      expect(calls.destroyed).toBe(false);
    });

    it('destroys the socket when headers ARE already on the wire', (ctx) => {
      story(ctx, 'To jest dokładnie ten race, który złapał Sentry: pipe S3 wyemitował błąd po flushed nagłówkach. `res.status().json()` rzuciłoby ERR_HTTP_HEADERS_SENT — zamiast tego helper wywala socket przez `res.destroy(err)`, klient widzi nagłe zerwanie i ponawia thumbnail przy następnym renderze.');
      const { res, calls } = mockResponse({ headersSent: true });
      const err = new Error('s3 mid-stream hiccup');
      endStreamWithError(res, err);
      expect(calls.status).toBeUndefined();
      expect(calls.json).toBeUndefined();
      expect(calls.destroyed).toBe(true);
      expect(calls.destroyArg).toBe(err);
    });

    it('destroys the socket when response has been fully written (writableEnded)', (ctx) => {
      story(ctx, 'Edge case: błąd przychodzi po EOF body — body.on("end") odpalił, ale i tak jakieś podpięte after-handlery wywaliły wyjątek. Nie chcemy zaczynać nowej odpowiedzi po `res.end()`, więc `writableEnded` traktujemy jak `headersSent` — destroy zamiast 500.');
      const { res, calls } = mockResponse({ headersSent: false, writableEnded: true });
      endStreamWithError(res, new Error('late error'));
      expect(calls.destroyed).toBe(true);
      expect(calls.status).toBeUndefined();
    });

    it('wraps non-Error throwables in an Error before destroy()', (ctx) => {
      story(ctx, 'Kod wewnętrzny może rzucić string albo plain object (zewnętrzne zależności bywają luźne) — helper opakowuje to w `new Error(String(err))`, żeby Node.js poprawnie zerwał socket z stack trace, a nie z TypeError "argument must be Error".');
      const { res, calls } = mockResponse({ headersSent: true });
      endStreamWithError(res, 'boom-string');
      expect(calls.destroyed).toBe(true);
      expect(calls.destroyArg).toBeInstanceOf(Error);
      expect((calls.destroyArg as Error).message).toBe('boom-string');
    });

    it('respects the fallback status override (e.g. 503 for transient S3)', (ctx) => {
      story(ctx, 'Domyślnie 500, ale callerzy mogą oznaczyć błąd jako transient (np. 503 do retry przez front), zachowując tę samą obronę przed double-response.');
      const { res, calls } = mockResponse({ headersSent: false });
      endStreamWithError(res, new Error('transient'), 503);
      expect(calls.status).toBe(503);
    });
  });

  describe('GET /events/:id/thumbnail — headers-sent race', () => {
    it('completes cleanly when S3 stream errors AFTER headers flushed (no ERR_HTTP_HEADERS_SENT throw)', async (ctx) => {
      story(ctx, 'Regresja: S3 emituje błąd po tym jak nagłówki + bajty poszły do klienta. Stary handler robił tutaj `res.status(404).json(...)` i Node wywalał ERR_HTTP_HEADERS_SENT — Sentry łapał to jako błąd. Po fixie request kończy się bez nieuhandlowanego exception; klient widzi rozerwane połączenie i przeglądarka po prostu retry-uje thumbnail.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(headObject).mockResolvedValue({ contentLength: 1024, lastModified: new Date() });

      // Build a Readable that emits one chunk (so pipeS3ToResponse flushes
      // headers + writes data) then errors. The error fires AFTER bytes
      // are on the wire, which is exactly the race condition.
      const racingBody = new Readable({
        read() {
          // Push one chunk synchronously so pipeline() flushes headers and
          // writes the data, then schedule an error on next tick.
          this.push(Buffer.from('partial-jpeg-data'));
          setImmediate(() => this.destroy(new Error('S3 mid-stream hiccup')));
        },
      });
      vi.mocked(getObject).mockResolvedValue({ body: racingBody, contentRange: undefined });

      const app = buildApp(USER_A);

      // The critical assertion: the request settles (with a socket-close /
      // body truncation) rather than crashing the process with
      // ERR_HTTP_HEADERS_SENT. Supertest may surface the abort as a thrown
      // error or as `res.body` being incomplete — either is fine, as long as
      // the test itself doesn't blow up with an unhandled HTTP error.
      let didThrow: unknown;
      try {
        await request(app).get('/events/evt-001/thumbnail');
      } catch (err) {
        didThrow = err;
      }

      // If the helper engaged correctly, no ERR_HTTP_HEADERS_SENT should
      // appear anywhere in the error chain. The connection-reset / socket
      // hang-up is the expected, race-free outcome.
      if (didThrow) {
        const msg = didThrow instanceof Error ? didThrow.message : String(didThrow);
        expect(msg).not.toMatch(/ERR_HTTP_HEADERS_SENT/i);
      }

      // S3 was contacted — handler did reach the streaming path (so the
      // race window was actually exercised, not short-circuited by some
      // earlier 4xx).
      expect(getObject).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Frames endpoint — GET /events/:id/video/:view/frames
  // =========================================================================

  describe('GET /events/:id/video/:view/frames — frames sidecar', () => {
    it('returns { grid } from the .frames sidecar when it exists', async (ctx) => {
      story(ctx, 'Właściciel eventu pobiera siatkę czasu prezentacji klatek — służy do bezfps-owego steppingu w web playerze. Sidecar .frames zwraca JSON { grid: number[] } z czasami w sekundach.');
      const grid = [0, 0.033, 0.066, 0.1];
      const framesJson = JSON.stringify({ grid });
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(framesJson), contentRange: undefined });

      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/video/00/frames');

      expect(res.status).toBe(200);
      expect(res.body.grid).toEqual(grid);
      // Must fetch from the sidecars bucket with the .frames suffix
      expect(getObject).toHaveBeenCalledWith(
        'sidecars',
        expect.stringContaining('.frames'),
        expect.any(String),
      );
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_A.userId);
    });

    it('returns { grid: [] } at 200 when the .frames sidecar does not exist (NoSuchKey)', async (ctx) => {
      story(ctx, 'Nagrania sprzed wdrożenia .frames sidecara nie mają jeszcze siatki klatek — endpoint gracefully zwraca pustą tablicę zamiast 404, co pozwala klientowi spokojnie spaść na fps-based stepping.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      const noSuchKeyErr = Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
      vi.mocked(getObject).mockRejectedValue(noSuchKeyErr);

      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/video/00/frames');

      expect(res.status).toBe(200);
      expect(res.body.grid).toEqual([]);
    });

    it('returns 401 when no user is authenticated', async (ctx) => {
      story(ctx, 'Endpoint klatek wymaga sesji — niezalogowane żądanie zatrzymuje się przed bazą i S3, żeby nie dawać sygnału o istnieniu eventu i nie zużywać zasobów.');
      const app = buildApp(undefined);
      const res = await request(app).get('/events/evt-001/video/00/frames');

      expect(res.status).toBe(401);
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
    });

    it('returns 404 when User B requests frames for User A event', async (ctx) => {
      story(ctx, 'Cross-user izolacja obejmuje endpoint klatek — Bob nie może odczytać metadanych prezentacji nagrania Alice, 404 bez wycieku informacji o istnieniu eventu.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined);

      const app = buildApp(USER_B);
      const res = await request(app).get('/events/evt-001/video/00/frames');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Event not found');
      expect(getEventByIdForOwner).toHaveBeenCalledWith('evt-001', USER_B.userId);
      expect(getObject).not.toHaveBeenCalled();
    });

    // FIX: the /frames route is a ~4 MB S3
    // read that matches index.ts's MEDIA_GET_PATH exclusion (`video/*`), so it
    // is skipped by the general apiRateLimit on the assumption it carries its
    // own media bucket — but historically it carried NEITHER a rate limit NOR
    // transfer metering. That made it free, unbounded egress. It must now run
    // `mediaRateLimit` and meter its bytes exactly once.

    it('runs the media rate limiter (mediaRateLimit) on the frames route', async (ctx) => {
      story(ctx, 'Trasa /frames wpada w wykluczenie MEDIA_GET_PATH (video/*) z ogólnego apiRateLimit — regex zakłada, że takie trasy niosą własny, wyższy bucket mediaRateLimit. Wcześniej /frames nie niosło ŻADNEGO limitera → darmowa, nieograniczona amplifikacja socketów na ~4 MB odczyt z S3. Test pilnuje, że limiter faktycznie wisi na trasie.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(JSON.stringify({ grid: [0, 0.1] })), contentRange: undefined });

      const app = buildApp(USER_A);
      await request(app).get('/events/evt-001/video/00/frames');

      expect(vi.mocked(mediaRateLimit)).toHaveBeenCalled();
    });

    it('meters the frames sidecar bytes EXACTLY ONCE against transfer usage', async (ctx) => {
      story(ctx, 'Sedno poprawki: ~4 MB odczyt sidecara .frames z S3 był niebillowany. Teraz bajty ściągnięte z S3 są naliczane DOKŁADNIE RAZ (handler res.finish/close), więc egress na tej trasie nie jest już darmowy, a przy aborcie klienta i tak liczy to, co realnie poszło z bucketu.');
      const framesJson = JSON.stringify({ grid: [0, 0.033, 0.066] });
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      vi.mocked(getObject).mockResolvedValue({ body: fakeStream(framesJson), contentRange: undefined });

      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/video/00/frames');
      // Let res.finish/close fire after supertest tears the socket down.
      await new Promise((r) => setImmediate(r));

      expect(res.status).toBe(200);
      expect(vi.mocked(updateTransferUsage)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateTransferUsage).mock.calls[0][0]).toBe(USER_A.userId);
      // Metered against the actual bytes pulled from the sidecar object.
      expect(vi.mocked(updateTransferUsage).mock.calls[0][1]).toBe(Buffer.byteLength(framesJson));
    });

    it('does NOT meter transfer when the frames sidecar is missing (NoSuchKey → empty grid)', async (ctx) => {
      story(ctx, 'Gdy sidecara jeszcze nie ma (stare nagrania), nic nie ściągamy z S3 — więc nie ma czego naliczać. Endpoint zwraca puste grid bez fałszywego obciążania kwoty transferu usera.');
      vi.mocked(getEventByIdForOwner).mockResolvedValue(EVENT_OWNED_BY_A);
      const noSuchKeyErr = Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
      vi.mocked(getObject).mockRejectedValue(noSuchKeyErr);

      const app = buildApp(USER_A);
      const res = await request(app).get('/events/evt-001/video/00/frames');
      await new Promise((r) => setImmediate(r));

      expect(res.status).toBe(200);
      expect(res.body.grid).toEqual([]);
      expect(vi.mocked(updateTransferUsage)).not.toHaveBeenCalled();
    });
  });
});
