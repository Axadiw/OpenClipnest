import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

const REAL_NOW = Date.parse('2026-07-31T10:00:00.000Z');
const EVENT: Partial<CameraEvent> = {
  id: 'ev-now', camera: 'Front', timestamp: '2026-07-31T09:00:00.000Z', date: '2026-07-31',
  timezone: 'UTC', duration: 30, views: [{ id: '00', videoRelPath: 'front/00.mp4', sizeBytes: 1024 }],
};

const { getVideoUrl } = vi.hoisted(() => ({ getVideoUrl: vi.fn() }));

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body?: Record<string, unknown>) { super(message); }
  }
  return {
    api: {
      getEvents: ({ dateFrom }: { dateFrom?: string }) =>
        Promise.resolve({ events: (!dateFrom || dateFrom === '2026-07-31') ? [EVENT] : [] }),
      getAccountTimezone: () => Promise.resolve({ timezone: 'UTC' }),
      getEventCalendar: () => Promise.resolve({ days: [] }),
      getEvent: (id: string) => Promise.resolve({ event: { id } }),
      getCameras: () => Promise.resolve({ cameras: ['Front'] }),
      getVideoUrl: (...a: unknown[]) => getVideoUrl(...a),
      getFrameGrid: () => Promise.resolve({ frames: [] }),
      fetchThumbnailBlob: () => Promise.resolve('blob:thumb'),
    },
    ApiError,
  };
});

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('clipnest.accountTimezone', 'UTC');
  vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(REAL_NOW);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); getVideoUrl.mockReset(); });

describe('TimelineView — locked account', () => {
  it('shows the locked message instead of an endless loading state', async (ctx) => {
    story(ctx, 'Zablokowane konto otwiera klip na osi czasu: zamiast wiecznego "Loading..." widzi komunikat, bez spinnera i bez przycisków ponawiania.');
    const { ApiError } = await import('../api');
    getVideoUrl.mockRejectedValue(new ApiError('Account locked', 403, { code: 'ACCOUNT_LOCKED' }));
    const { TimelineView } = await import('./TimelineView');
    renderWithRouter(<TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />, { route: '/timeline' });

    await waitFor(() => expect(screen.getByTestId('timeline-inline-locked')).toHaveTextContent('account.lockedPlayback'));
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.queryByTestId('timeline-playhead-buffer')).toBeNull();
    expect(screen.queryByTestId('player-buffer-retry')).toBeNull();
  });

  it('keeps the plain loading state for other failures', async (ctx) => {
    story(ctx, 'Inny błąd niż blokada konta nie pokazuje komunikatu o blokadzie.');
    getVideoUrl.mockRejectedValue(new Error('boom'));
    const { TimelineView } = await import('./TimelineView');
    renderWithRouter(<TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />, { route: '/timeline' });
    await waitFor(() => expect(getVideoUrl).toHaveBeenCalled());
    expect(screen.queryByTestId('timeline-inline-locked')).toBeNull();
  });
});
