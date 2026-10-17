import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const {
  mockGetAdminUsageSnapshot,
  mockBulkResetExpiredTransfers,
  mockGetUserQuota,
  mockCheckAndResetTransfer,
  mockGetAllUsersCameraBreakdown,
  mockGetDiskUsageByCamera,
} = vi.hoisted(() => ({
  mockGetAdminUsageSnapshot: vi.fn(),
  mockBulkResetExpiredTransfers: vi.fn(),
  mockGetUserQuota: vi.fn(),
  mockCheckAndResetTransfer: vi.fn(),
  mockGetAllUsersCameraBreakdown: vi.fn(),
  mockGetDiskUsageByCamera: vi.fn(),
}));

vi.mock('../db/queries/storage.js', () => ({
  getUserQuota: (...args: unknown[]) => mockGetUserQuota(...args),
  checkAndResetTransfer: (...args: unknown[]) => mockCheckAndResetTransfer(...args),
  getAdminUsageSnapshot: (...args: unknown[]) => mockGetAdminUsageSnapshot(...args),
  bulkResetExpiredTransfers: (...args: unknown[]) => mockBulkResetExpiredTransfers(...args),
  getAutoDeleteOldest: vi.fn(),
  setAutoDeleteOldest: vi.fn(),
  getAutoDeleteAfterDays: vi.fn(),
  setAutoDeleteAfterDays: vi.fn(),
  getAllUsersUploadStats: vi.fn().mockResolvedValue([]),
  getAllUsersCameraBreakdown: (...args: unknown[]) => mockGetAllUsersCameraBreakdown(...args),
  getDiskUsageByCamera: (...args: unknown[]) => mockGetDiskUsageByCamera(...args),
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

describe('usage — GET /by-camera', () => {
  let app: express.Express;
  let currentUser: { userId: number; isAdmin: boolean; email: string; userUuid: string } | null = null;

  function injectUser(req: Request, _res: Response, next: NextFunction) {
    if (currentUser) req.user = currentUser as Request['user'];
    next();
  }

  function createUserApp() {
    const a = express();
    a.use(express.json());
    a.use(injectUser);
    a.use('/api/v0/usage', usageRouter);
    return a;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: 42, isAdmin: false, email: 'alice@test.com', userUuid: 'alice-uuid' };
    app = createUserApp();
  });

  it('returns the per-camera breakdown sorted by bytes DESC', async (ctx) => {
    story(ctx, 'Strona Storage rysuje stacked bar i listę per-kamera — endpoint zwraca już posortowane po bajtach malejąco, więc UI nie musi tego sortować ponownie i ribbon w UI od razu pokazuje "kto żre dysk".');
    mockGetDiskUsageByCamera.mockResolvedValue([
      { cameraName: 'Backyard', bytes: 412_700_000_000, durationSeconds: 938 * 3600, eventCount: 1842 },
      { cameraName: 'Lobby', bytes: 287_100_000_000, durationSeconds: 651 * 3600, eventCount: 1311 },
      { cameraName: 'Porch', bytes: 0, durationSeconds: 0, eventCount: 0 },
    ]);
    const res = await request(app).get('/api/v0/usage/by-camera');
    expect(res.status).toBe(200);
    expect(res.body.cameras).toHaveLength(3);
    expect(res.body.cameras[0]).toEqual({
      cameraName: 'Backyard',
      bytes: 412_700_000_000,
      durationSeconds: 938 * 3600,
      eventCount: 1842,
    });
    expect(mockGetDiskUsageByCamera).toHaveBeenCalledWith(42);
  });

  it('returns an empty array for a user with no events', async (ctx) => {
    story(ctx, 'Świeżo zarejestrowany user nie ma jeszcze żadnego eventa — endpoint zwraca pustą tablicę zamiast 404, żeby UI mógł narysować empty-state ("No recordings yet") bez specjalnego case-handlowania błędów.');
    mockGetDiskUsageByCamera.mockResolvedValue([]);
    const res = await request(app).get('/api/v0/usage/by-camera');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cameras: [] });
  });

  it('blocks unauthenticated access', async (ctx) => {
    story(ctx, '401 dla niezalogowanego — per-kamerowy breakdown to dane usera (nazwy jego kamer + ile nagrał), więc nikt bez tokena nie może ich pobrać.');
    currentUser = null;
    const res = await request(app).get('/api/v0/usage/by-camera');
    expect(res.status).toBe(401);
    expect(mockGetDiskUsageByCamera).not.toHaveBeenCalled();
  });

  it('rejects admin caller', async (ctx) => {
    story(ctx, 'Admin nie ma własnej kwoty ani własnych nagrań — w Settings → Storage tab jest dla admina ukryty, więc endpoint zwraca 403 spójnie z resztą /usage/* dla nie-userów.');
    currentUser = { userId: 1, isAdmin: true, email: 'admin@x', userUuid: 'admin-uuid' };
    const res = await request(app).get('/api/v0/usage/by-camera');
    expect(res.status).toBe(403);
    expect(mockGetDiskUsageByCamera).not.toHaveBeenCalled();
  });
});
