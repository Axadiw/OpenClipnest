import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationsBell } from './NotificationsBell';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';

const apiMocks = vi.hoisted(() => ({
  getUnreadNotificationCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
  deleteReadNotifications: vi.fn(),
}));

vi.mock('../api', () => ({
  api: apiMocks,
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('NotificationsBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getUnreadNotificationCount.mockResolvedValue({ count: 0 });
    apiMocks.listNotifications.mockResolvedValue({ notifications: [] });
    apiMocks.markNotificationRead.mockResolvedValue({ success: true });
    apiMocks.markAllNotificationsRead.mockResolvedValue({ success: true, updated: 0 });
    apiMocks.deleteNotification.mockResolvedValue({ success: true });
    apiMocks.deleteReadNotifications.mockResolvedValue({ success: true, deleted: 0 });
  });

  it('shows unread badge when count > 0', async (ctx) => {
    story(ctx, 'Użytkownik widzi czerwoną plakietkę z liczbą nieprzeczytanych powiadomień — zwraca uwagę na nowe zdarzenia bez konieczności klikania w dzwonek.');
    apiMocks.getUnreadNotificationCount.mockResolvedValue({ count: 3 });
    renderWithRouter(<NotificationsBell />);
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
  });

  it('renders "99+" when count exceeds 99', async (ctx) => {
    story(ctx, 'Gdy nieprzeczytanych powiadomień jest bardzo dużo, plakietka skraca liczbę do "99+" — unika rozwalenia układu paska nawigacyjnego.');
    apiMocks.getUnreadNotificationCount.mockResolvedValue({ count: 150 });
    renderWithRouter(<NotificationsBell />);
    await waitFor(() => expect(screen.getByText('99+')).toBeInTheDocument());
  });

  it('does not show badge when count is zero', async (ctx) => {
    story(ctx, 'Gdy wszystko jest przeczytane, dzwonek jest "czysty" bez plakietki — użytkownik nie jest niepokojony bez powodu.');
    renderWithRouter(<NotificationsBell />);
    await waitFor(() => expect(apiMocks.getUnreadNotificationCount).toHaveBeenCalled());
    expect(document.querySelector('.notifications-badge')).toBeNull();
  });

  it('opens dropdown and lists notifications on click', async (ctx) => {
    story(ctx, 'Kliknięcie w dzwonek rozwija listę powiadomień — użytkownik od razu widzi treść zdarzeń bez potrzeby przechodzenia na osobną stronę.');
    apiMocks.listNotifications.mockResolvedValue({
      notifications: [
        {
          id: '7', userId: 1, kind: 'invalid_file',
          message: 'Bad upload', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z',
        },
      ],
    });
    renderWithRouter(<NotificationsBell />);
    const btn = screen.getByRole('button', { name: 'notifications.title' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('Bad upload')).toBeInTheDocument());
    expect(apiMocks.listNotifications).toHaveBeenCalledWith({ limit: 50 });
  });

  it('marks notification as read when clicked', async (ctx) => {
    story(ctx, 'Kliknięcie w powiadomienie oznacza je jako przeczytane — licznik nieprzeczytanych maleje, dzięki czemu użytkownik widzi swój postęp w przeglądaniu.');
    apiMocks.listNotifications.mockResolvedValue({
      notifications: [
        {
          id: '7', userId: 1, kind: 'invalid_file',
          message: 'Bad upload', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z',
        },
      ],
    });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.title' }));
    const item = await screen.findByText('Bad upload');
    fireEvent.click(item);
    await waitFor(() => expect(apiMocks.markNotificationRead).toHaveBeenCalledWith('7'));
  });

  it('groups multiple notifications of the same kind under a single header', async (ctx) => {
    story(ctx, 'Kiedy nadejdzie wiele powiadomień tego samego typu (np. seria nieprawidłowych plików z kamery), użytkownik widzi jeden zwinięty nagłówek z licznikiem zamiast 30 podobnych wierszy zaśmiecających listę.');
    apiMocks.listNotifications.mockResolvedValue({
      notifications: [
        { id: '1', userId: 1, kind: 'invalid_file', message: 'Bad A', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z' },
        { id: '2', userId: 1, kind: 'invalid_file', message: 'Bad B', details: null, readAt: null, createdAt: '2026-04-15T10:01:00Z' },
        { id: '3', userId: 1, kind: 'invalid_file', message: 'Bad C', details: null, readAt: null, createdAt: '2026-04-15T10:02:00Z' },
        { id: '9', userId: 1, kind: 'user_banned', message: 'You are banned', details: null, readAt: null, createdAt: '2026-04-15T09:00:00Z' },
      ],
    });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.title' }));
    await waitFor(() => expect(screen.getByText('You are banned')).toBeInTheDocument());
    expect(screen.getByText('notifications.kind.invalid_file')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('Bad A')).toBeNull();
    expect(screen.queryByText('Bad B')).toBeNull();
    expect(screen.queryByText('Bad C')).toBeNull();
  });

  it('expands a group when its header is clicked', async (ctx) => {
    story(ctx, 'Klik na nagłówek grupy rozwija listę indywidualnych powiadomień — użytkownik może przejrzeć szczegóły każdego zdarzenia gdy potrzebuje, ale domyślnie nie zaśmieca to widoku.');
    apiMocks.listNotifications.mockResolvedValue({
      notifications: [
        { id: '1', userId: 1, kind: 'invalid_file', message: 'Bad A', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z' },
        { id: '2', userId: 1, kind: 'invalid_file', message: 'Bad B', details: null, readAt: null, createdAt: '2026-04-15T10:01:00Z' },
      ],
    });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'notifications.title' }));
    const header = await screen.findByText('notifications.kind.invalid_file');
    fireEvent.click(header);
    await waitFor(() => expect(screen.getByText('Bad A')).toBeInTheDocument());
    expect(screen.getByText('Bad B')).toBeInTheDocument();
  });

  it('deletes all notifications of a kind when the group trash button is clicked', async (ctx) => {
    story(ctx, 'Jednym kliknięciem na koszyk przy nagłówku grupy użytkownik może wyczyścić cały szum tego samego typu (np. 30 nieprawidłowych plików z jednej awarii kamery) zamiast usuwać każdy wpis osobno.');
    apiMocks.listNotifications.mockResolvedValue({
      notifications: [
        { id: '1', userId: 1, kind: 'invalid_file', message: 'Bad A', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z' },
        { id: '2', userId: 1, kind: 'invalid_file', message: 'Bad B', details: null, readAt: null, createdAt: '2026-04-15T10:01:00Z' },
        { id: '3', userId: 1, kind: 'invalid_file', message: 'Bad C', details: null, readAt: null, createdAt: '2026-04-15T10:02:00Z' },
        { id: '9', userId: 1, kind: 'user_banned', message: 'You are banned', details: null, readAt: null, createdAt: '2026-04-15T09:00:00Z' },
      ],
    });
    const confirmFn = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmFn);
    try {
      renderWithRouter(<NotificationsBell />);
      fireEvent.click(screen.getByRole('button', { name: 'notifications.title' }));
      await screen.findByText('notifications.kind.invalid_file');
      const groupTrash = screen.getByRole('button', { name: 'notifications.deleteAllOfKind' });
      fireEvent.click(groupTrash);
      expect(confirmFn).toHaveBeenCalled();
      await waitFor(() => expect(apiMocks.deleteNotification).toHaveBeenCalledTimes(3));
      const deletedIds = apiMocks.deleteNotification.mock.calls.map(c => c[0]).sort();
      expect(deletedIds).toEqual(['1', '2', '3']);
      await waitFor(() => expect(screen.queryByText('notifications.kind.invalid_file')).toBeNull());
      expect(screen.getByText('You are banned')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not delete the group when confirm is cancelled', async (ctx) => {
    story(ctx, 'Jeśli użytkownik przypadkowo kliknie koszyk przy grupie, dialog potwierdzenia daje mu wycofanie się — nie tracimy danych przez chybiony klik.');
    apiMocks.listNotifications.mockResolvedValue({
      notifications: [
        { id: '1', userId: 1, kind: 'invalid_file', message: 'Bad A', details: null, readAt: null, createdAt: '2026-04-15T10:00:00Z' },
        { id: '2', userId: 1, kind: 'invalid_file', message: 'Bad B', details: null, readAt: null, createdAt: '2026-04-15T10:01:00Z' },
      ],
    });
    const confirmFn = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirmFn);
    try {
      renderWithRouter(<NotificationsBell />);
      fireEvent.click(screen.getByRole('button', { name: 'notifications.title' }));
      await screen.findByText('notifications.kind.invalid_file');
      fireEvent.click(screen.getByRole('button', { name: 'notifications.deleteAllOfKind' }));
      expect(confirmFn).toHaveBeenCalled();
      expect(apiMocks.deleteNotification).not.toHaveBeenCalled();
      expect(screen.getByText('notifications.kind.invalid_file')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
