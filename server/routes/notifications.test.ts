import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { story } from '../testing/story.js';

const {
  mockListNotifications,
  mockMarkNotificationRead,
  mockMarkAllNotificationsRead,
  mockGetUnreadNotificationCount,
  mockDeleteNotification,
  mockDeleteReadNotifications,
} = vi.hoisted(() => ({
  mockListNotifications: vi.fn(),
  mockMarkNotificationRead: vi.fn(),
  mockMarkAllNotificationsRead: vi.fn(),
  mockGetUnreadNotificationCount: vi.fn(),
  mockDeleteNotification: vi.fn(),
  mockDeleteReadNotifications: vi.fn(),
}));

let currentUser: { userId: number; isAdmin: boolean; email: string; userUuid: string } | null = null;

vi.mock('../db/queries/notifications.js', () => ({
  listNotifications: (...args: unknown[]) => mockListNotifications(...args),
  markNotificationRead: (...args: unknown[]) => mockMarkNotificationRead(...args),
  markAllNotificationsRead: (...args: unknown[]) => mockMarkAllNotificationsRead(...args),
  getUnreadNotificationCount: (...args: unknown[]) => mockGetUnreadNotificationCount(...args),
  deleteNotification: (...args: unknown[]) => mockDeleteNotification(...args),
  deleteReadNotifications: (...args: unknown[]) => mockDeleteReadNotifications(...args),
}));

import notificationsRouter from './notifications.js';

function injectUser(req: Request, _res: Response, next: NextFunction) {
  if (currentUser) req.user = currentUser as Request['user'];
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(injectUser);
  app.use('/api/v0/notifications', notificationsRouter);
  return app;
}

describe('notifications router', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: 42, isAdmin: false, email: 'alice@test.com', userUuid: 'alice-uuid' };
    app = createApp();
  });

  it('lists notifications for the authenticated user', async (ctx) => {
    story(ctx, 'User otwiera panel powiadomień i widzi tylko swoje komunikaty — filtrowanie po userId ze JWT gwarantuje, że nie zobaczy cudzych alertów.');
    mockListNotifications.mockResolvedValue([
      { id: '1', userId: 42, kind: 'invalid_file', message: 'Bad upload', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z' },
    ]);
    const res = await request(app).get('/api/v0/notifications?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(mockListNotifications).toHaveBeenCalledWith(42, { limit: 10, before: undefined });
  });

  it('passes through before cursor for pagination', async (ctx) => {
    story(ctx, 'Paginator cursor-based pozwala listować starsze powiadomienia — user może doczytać historię alertów, np. po dłuższej nieobecności w panelu.');
    mockListNotifications.mockResolvedValue([]);
    const res = await request(app).get('/api/v0/notifications?before=100&limit=5');
    expect(res.status).toBe(200);
    expect(mockListNotifications).toHaveBeenCalledWith(42, { limit: 5, before: '100' });
  });

  it('returns unread count for the caller', async (ctx) => {
    story(ctx, 'Licznik nieprzeczytanych zasila czerwoną kropkę na ikonie dzwonka w UI — daje userowi szybki sygnał, że coś wymaga uwagi.');
    mockGetUnreadNotificationCount.mockResolvedValue(3);
    const res = await request(app).get('/api/v0/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
    expect(mockGetUnreadNotificationCount).toHaveBeenCalledWith(42);
  });

  it('marks a single notification read', async (ctx) => {
    story(ctx, 'Kliknięcie na konkretne powiadomienie oznacza je jako przeczytane — licznik nieprzeczytanych i czerwona kropka znikają, gdy user rzeczywiście zareagował.');
    mockMarkNotificationRead.mockResolvedValue(true);
    const res = await request(app).post('/api/v0/notifications/7/read').send({});
    expect(res.status).toBe(200);
    expect(mockMarkNotificationRead).toHaveBeenCalledWith(42, '7');
  });

  it('returns 404 when notification does not belong to user or is already read', async (ctx) => {
    story(ctx, 'Próba oznaczenia cudzego powiadomienia daje 404 — blokuje enumerację ID przez atakującego, który chciałby sprawdzić istnienie notyfikacji innego konta.');
    mockMarkNotificationRead.mockResolvedValue(false);
    const res = await request(app).post('/api/v0/notifications/99/read').send({});
    expect(res.status).toBe(404);
  });

  it('marks all notifications read and reports count', async (ctx) => {
    story(ctx, 'Przycisk „oznacz wszystkie jako przeczytane” czyści licznik hurtowo — UX pozwala userowi wrócić do zerowego stanu jednym kliknięciem.');
    mockMarkAllNotificationsRead.mockResolvedValue(5);
    const res = await request(app).post('/api/v0/notifications/read-all').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, updated: 5 });
  });

  it('deletes a single notification owned by the caller', async (ctx) => {
    story(ctx, 'User może trwale usunąć konkretne powiadomienie ze swojej listy — porządkowanie archiwum alertów jest w rękach usera.');
    mockDeleteNotification.mockResolvedValue(true);
    const res = await request(app).delete('/api/v0/notifications/7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockDeleteNotification).toHaveBeenCalledWith(42, '7');
  });

  // Regression: returning 200 for a cross-user ID would let a logged-in
  // attacker probe whether a given notification ID exists under another
  // account. 404 keeps enumeration closed.
  it('returns 404 when deleting a notification that does not belong to the caller', async (ctx) => {
    story(ctx, 'Próba skasowania cudzego powiadomienia zwraca 404 — regresja, która broni przed wyciekiem informacji o istnieniu notyfikacji innych użytkowników.');
    mockDeleteNotification.mockResolvedValue(false);
    const res = await request(app).delete('/api/v0/notifications/999');
    expect(res.status).toBe(404);
  });

  it('bulk deletes all read notifications and reports the count', async (ctx) => {
    story(ctx, 'User jednym kliknięciem sprząta wszystkie przeczytane powiadomienia — po dłuższym korzystaniu aplikacja nie zbiera śmieci w panelu alertów.');
    mockDeleteReadNotifications.mockResolvedValue(4);
    const res = await request(app).delete('/api/v0/notifications');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 4 });
    expect(mockDeleteReadNotifications).toHaveBeenCalledWith(42);
  });
});
