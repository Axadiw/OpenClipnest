import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

const EVENT = {
  id: 'ev1', camera: 'Porch', timestamp: '2026-10-18T10:00:00', date: '2026-10-18', thumbnail: 't.jpg', duration: 20,
  views: [{ id: '00', videoRelPath: 'p/00.mp4', durationMs: 20000 }],
} as CameraEvent;

const { getVideoUrl } = vi.hoisted(() => ({ getVideoUrl: vi.fn() }));

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(message: string, public status: number, public body?: Record<string, unknown>) { super(message); }
  }
  return {
    api: {
      getVideoUrl: (...a: unknown[]) => getVideoUrl(...a),
      getFrameGrid: () => Promise.resolve([]),
      fetchThumbnailBlob: () => Promise.resolve('blob:thumb'),
      downloadVideo: vi.fn(),
    },
    ApiError,
  };
});

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn(); });
});

describe('VideoPlayer — locked account', () => {
  it('shows the locked message and no retry/cancel buttons', async (ctx) => {
    story(ctx, 'Odtwarzacz zablokowanego konta pokazuje komunikat zamiast spinnera, bez ponawiania.');
    const { ApiError } = await import('../api');
    getVideoUrl.mockRejectedValue(new ApiError('Account locked', 403, { code: 'ACCOUNT_LOCKED' }));
    const { VideoPlayer } = await import('./VideoPlayer');
    render(<VideoPlayer event={EVENT} view="00" events={[EVENT]} onClose={() => {}} onNavigate={() => {}} />);

    await screen.findByText('account.lockedPlayback');
    expect(screen.getByText('account.lockedPlayback')).toBeTruthy();
    expect(screen.queryByTestId('player-buffer-retry')).toBeNull();
    expect(screen.queryByTestId('player-buffer-actions')).toBeNull();
    expect(document.querySelector('.spinner')).toBeNull();
  });
});
