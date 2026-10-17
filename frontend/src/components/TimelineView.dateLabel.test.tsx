import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

// The header's date label reads instants that are UTC-midnight aligned. A
// browser west of Greenwich sees those land on the PREVIOUS local day — that
// is the bug this file guards, so it runs pinned to a negative-offset zone.
// V8 re-reads `TZ` per Date operation, so flipping it around each test is
// enough; nothing here caches the zone at import time.
declare const process: { env: Record<string, string | undefined> };
const BROWSER_TZ = 'America/New_York';
let originalTz: string | undefined;

const ACCOUNT_TZ = 'Europe/Warsaw';
const EVENT: Partial<CameraEvent> = {
  id: 'ev-1', camera: 'Front',
  timestamp: '2026-07-31T12:00:00.000Z', date: '2026-07-31',
  timezone: ACCOUNT_TZ, duration: 30, views: [{ id: '00', videoRelPath: 'front/00.mp4', sizeBytes: 1024 }],
};

vi.mock('../api', () => ({
  api: {
    getEvents: ({ dateFrom }: { dateFrom: string }) =>
      Promise.resolve({ events: dateFrom === '2026-07-31' ? [EVENT as CameraEvent] : [] }),
    getAccountTimezone: () => Promise.resolve({ timezone: ACCOUNT_TZ }),
    getEventCalendar: () => Promise.resolve({ days: [] }),
    getEvent: (id: string) => Promise.resolve({ event: { id } }),
    getCameras: () => Promise.resolve({ cameras: ['Front'] }),
    getVideoUrl: () => Promise.resolve({ videoUrl: 'blob:video', totalBytes: 1024 }),
    getFrameGrid: () => Promise.resolve({ frames: [] }),
    fetchThumbnailBlob: () => Promise.resolve('blob:thumb'),
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key, language: 'en' }),
}));

beforeEach(() => {
  originalTz = process.env.TZ;
  process.env.TZ = BROWSER_TZ;
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  });
  // A day far from "now" so the label renders the absolute date rather than
  // the relative "today" string.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse('2026-09-10T15:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.TZ = originalTz;
});

describe('TimelineView date label — west of Greenwich', () => {
  it('names the framed day, not the browser-local day before it', async (ctx) => {
    story(ctx, 'Widok ramuje pełną dobę UTC, więc viewStart to północ UTC — a odczytany lokalnymi getterami w Nowym Jorku to jeszcze 20:00 dnia poprzedniego. Nagłówek pokazywał wtedy datę o dzień wcześniejszą niż słupki tuż pod nim: użytkownik czytał "30 lipca" nad nagraniami z 31. Polska tego nie widziała, bo dodatni offset przesuwa w drugą stronę.');
    // The view seeds its window from `window.location.search` directly (not
    // from the router), so MemoryRouter's entry alone wouldn't reach it.
    window.history.replaceState({}, '', '/timeline?date=2026-07-31');
    const { TimelineView } = await import('./TimelineView');
    renderWithRouter(
      <TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />,
      { route: '/timeline?date=2026-07-31' },
    );

    expect(await screen.findByText(/31 July 2026/)).toBeTruthy();
    expect(screen.queryByText(/30 July 2026/)).toBeNull();
  });
});
