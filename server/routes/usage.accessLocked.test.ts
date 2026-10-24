import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const { mockGetUserQuota, mockCheckAndResetTransfer, mockIsAccessLocked } = vi.hoisted(() => ({
  mockGetUserQuota: vi.fn(),
  mockCheckAndResetTransfer: vi.fn(),
  mockIsAccessLocked: vi.fn(),
}));

vi.mock('../db/queries/storage.js', () => ({
  getUserQuota: (...args: unknown[]) => mockGetUserQuota(...args),
  checkAndResetTransfer: (...args: unknown[]) => mockCheckAndResetTransfer(...args),
  getAutoDeleteOldest: vi.fn(),
  setAutoDeleteOldest: vi.fn(),
  getAutoDeleteAfterDays: vi.fn(),
  setAutoDeleteAfterDays: vi.fn(),
  getDiskUsageByCamera: vi.fn(),
}));
vi.mock('../db/queries/access.js', () => ({
  isAccessLocked: (...args: unknown[]) => mockIsAccessLocked(...args),
}));

import usageRouter from './usage.js';

describe('usage — GET / accessLocked', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAndResetTransfer.mockResolvedValue(undefined);
    mockGetUserQuota.mockResolvedValue({
      diskUsageBytes: 10, diskLimitBytes: 100,
      transferUsageBytes: 5, transferLimitBytes: 50, transferResetAt: null,
    });
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { userId: 42, isAdmin: false, email: 'a@test.com', userUuid: 'u' } as Request['user'];
      next();
    });
    app.use('/api/v0/usage', usageRouter);
  });

  it('GET /usage reports accessLocked', async (ctx) => {
    story(ctx, 'Strona ustawień wie, że konto jest zablokowane, i może pokazać baner.');
    mockIsAccessLocked.mockResolvedValueOnce(true);
    const res = await request(app).get('/api/v0/usage');
    expect(res.status).toBe(200);
    expect(res.body.accessLocked).toBe(true);
  });

  it('GET /usage reports accessLocked=false for a normal account', async (ctx) => {
    story(ctx, 'Zwykłe konto nie widzi banera.');
    mockIsAccessLocked.mockResolvedValueOnce(false);
    const res = await request(app).get('/api/v0/usage');
    expect(res.status).toBe(200);
    expect(res.body.accessLocked).toBe(false);
  });
});
