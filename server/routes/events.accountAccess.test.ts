import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import type { JwtPayload } from '../types.js';
import { story } from '../testing/story.js';

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

const { mockIsAccessLocked } = vi.hoisted(() => ({ mockIsAccessLocked: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../db/queries/access.js', () => ({ isAccessLocked: (...a: unknown[]) => mockIsAccessLocked(...(a as [])) }));

import eventsRouter from './events.js';
import { getEventByIdForOwner, deleteEvent } from '../db/queries/events.js';
import { getObject, cachedHeadObject } from '../services/s3.js';
import { generateMediaToken } from '../services/auth.js';

const USER = { userId: 1, userUuid: 'uuid-aaa-111', email: 'a@test', isAdmin: false } as JwtPayload;
// Event ids are opaque to the router (the lookup is mocked); the media-token
// scope check compares mediaEventId to the :id param verbatim.
const EVENT_ID = 'evt-001';

function buildApp(user: JwtPayload & { mediaEventId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => { req.user = { ...user }; next(); });
  app.use('/events', eventsRouter);
  return app;
}

describe('locked account on recording routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAccessLocked.mockResolvedValue(true);
    vi.mocked(getEventByIdForOwner).mockResolvedValue(undefined as never);
  });

  const cases: Array<[string, (a: express.Express) => request.Test]> = [
    ['POST media-token', (a) => request(a).post(`/events/${EVENT_ID}/media-token`)],
    ['HEAD video', (a) => request(a).head(`/events/${EVENT_ID}/video/00`)],
    ['GET video', (a) => request(a).get(`/events/${EVENT_ID}/video/00?fmt=clean`)],
    ['GET frames', (a) => request(a).get(`/events/${EVENT_ID}/video/00/frames`)],
    ['GET original', (a) => request(a).get(`/events/${EVENT_ID}/video/00/original`)],
    ['DELETE one', (a) => request(a).delete(`/events/${EVENT_ID}`)],
    ['DELETE bulk', (a) => request(a).delete(`/events?ids=${EVENT_ID}&confirm=true`)],
  ];

  for (const [name, call] of cases) {
    it(`${name} → 403 ACCOUNT_LOCKED before touching storage`, async (ctx) => {
      story(ctx, `Zablokowane konto nie może: ${name}. Serwer odmawia, zanim sięgnie do bazy nagrań lub S3 — także z media-tokenem wydanym przed blokadą.`);
      const res = await call(buildApp({ ...USER, mediaEventId: EVENT_ID }));
      expect(res.status).toBe(403);
      if (name !== 'HEAD video') expect(res.body.code).toBe('ACCOUNT_LOCKED');
      expect(getEventByIdForOwner).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
      expect(cachedHeadObject).not.toHaveBeenCalled();
      expect(deleteEvent).not.toHaveBeenCalled();
      expect(generateMediaToken).not.toHaveBeenCalled();
    });
  }

  it('the same requests are NOT refused with ACCOUNT_LOCKED once the account is unlocked', async (ctx) => {
    story(ctx, 'Kontrola sensowności: po odblokowaniu te same żądania docierają do właściwej logiki (tu: 404 brak zdarzenia), więc test blokady nie przechodzi na pusto.');
    mockIsAccessLocked.mockResolvedValue(false);
    for (const [name, call] of cases) {
      const res = await call(buildApp({ ...USER, mediaEventId: EVENT_ID }));
      expect(res.body?.code, name).not.toBe('ACCOUNT_LOCKED');
      expect(res.status, name).not.toBe(403);
    }
    expect(getEventByIdForOwner).toHaveBeenCalled();
  });

  it('thumbnail stays available to a locked account', async (ctx) => {
    story(ctx, 'Miniatury działają dalej — zablokowany użytkownik widzi, ile i jakie ma nagrania.');
    await request(buildApp(USER)).get(`/events/${EVENT_ID}/thumbnail`);
    expect(mockIsAccessLocked).not.toHaveBeenCalled();
  });

  it('listing stays available to a locked account', async (ctx) => {
    story(ctx, 'Lista nagrań działa dalej dla zablokowanego konta.');
    await request(buildApp(USER)).get('/events');
    expect(mockIsAccessLocked).not.toHaveBeenCalled();
  });
});
