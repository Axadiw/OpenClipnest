import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { story } from '../testing/story.js';

const { mockIsAccessLocked } = vi.hoisted(() => ({ mockIsAccessLocked: vi.fn() }));
vi.mock('../db/queries/access.js', () => ({ isAccessLocked: (...a: unknown[]) => mockIsAccessLocked(...a) }));

import { requireUnlockedAccount } from './accountAccess.js';

function app(user?: { userId: number }) {
  const a = express();
  a.use((req: Request, _res: Response, next: NextFunction) => { if (user) req.user = user as Request['user']; next(); });
  a.get('/x', requireUnlockedAccount, (_req, res) => { res.json({ ok: true }); });
  return a;
}

describe('requireUnlockedAccount', () => {
  beforeEach(() => mockIsAccessLocked.mockReset());

  it('passes an unlocked account through', async (ctx) => {
    story(ctx, 'Konto z pełnym dostępem przechodzi dalej bez zmian.');
    mockIsAccessLocked.mockResolvedValueOnce(false);
    const res = await request(app({ userId: 7 })).get('/x');
    expect(res.status).toBe(200);
    expect(mockIsAccessLocked).toHaveBeenCalledWith(7);
  });

  it('answers 403 ACCOUNT_LOCKED for a locked account', async (ctx) => {
    story(ctx, 'Zablokowane konto dostaje 403 z kodem ACCOUNT_LOCKED, po którym aplikacje pokazują właściwy komunikat.');
    mockIsAccessLocked.mockResolvedValueOnce(true);
    const res = await request(app({ userId: 7 })).get('/x');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account locked', code: 'ACCOUNT_LOCKED' });
  });

  it('answers 401 without a user', async (ctx) => {
    story(ctx, 'Bez zalogowanego użytkownika middleware nie pyta bazy i odpowiada 401.');
    const res = await request(app()).get('/x');
    expect(res.status).toBe(401);
    expect(mockIsAccessLocked).not.toHaveBeenCalled();
  });

  it('answers 500 when the lookup fails', async (ctx) => {
    story(ctx, 'Gdy baza nie odpowiada, odtwarzanie dostaje 500, a nie przepuszczenie bez sprawdzenia.');
    mockIsAccessLocked.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app({ userId: 7 })).get('/x');
    expect(res.status).toBe(500);
  });
});
