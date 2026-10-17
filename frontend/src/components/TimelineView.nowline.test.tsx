import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';
import type { CameraEvent } from '../types';

// Real UTC instant the test clock is frozen at. With a Europe/Warsaw account
// (+2 in summer) the cameras are stamping 12:00 right now — so the green
// now-line has to land on 12:00 of the wall-clock axis, NOT on 10:00.
const REAL_NOW = Date.parse('2026-07-31T10:00:00.000Z');
const ACCOUNT_TZ = 'Europe/Warsaw';

/** An event stamped at the exact wall clock the account is on right now. Its
 *  bar is the reference the now-line must line up with. */
const NOW_EVENT: Partial<CameraEvent> = {
  id: 'ev-now',
  camera: 'Front',
  timestamp: '2026-07-31T12:00:00.000Z',
  date: '2026-07-31',
  timezone: ACCOUNT_TZ,
  duration: 30,
  views: [{ id: '00', videoRelPath: 'front/00.mp4', sizeBytes: 1024 }],
};

const getEvents = vi.fn();
const getAccountTimezone = vi.fn();

vi.mock('../api', () => ({
  api: {
    getEvents: (...a: unknown[]) => getEvents(...a),
    getAccountTimezone: () => getAccountTimezone(),
    getEventCalendar: () => Promise.resolve({ days: [] }),
    getEvent: (id: string) => Promise.resolve({ event: { id } }),
    getCameras: () => Promise.resolve({ cameras: ['Front'] }),
    // The view auto-plays the latest clip in its inline player. Nothing here
    // asserts on playback, but the calls have to resolve or the effect throws
    // and takes the render down with it.
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

// The strip's width comes from a ResizeObserver, which jsdom never fires — so
// the view keeps `containerWidth`'s 800px default. Pixel assertions below are
// computed against that, and the >0 check guards against a future default of 0
// silently making every x collapse to the same value.
const TIMELINE_WIDTH = 800;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('clipnest.accountTimezone', ACCOUNT_TZ);
  getAccountTimezone.mockResolvedValue({ timezone: ACCOUNT_TZ });
  // The view fetches per UTC date and its window spans two date buckets
  // (00:00Z of the day + the closing midnight), so answer per-date — a blanket
  // mock hands the same event back twice and renders two bars for one clip.
  getEvents.mockImplementation(({ dateFrom }: { dateFrom: string }) =>
    Promise.resolve({ events: dateFrom === NOW_EVENT.date ? [NOW_EVENT as CameraEvent] : [] }));
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(REAL_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountTimeline() {
  const { TimelineView } = await import('./TimelineView');
  return renderWithRouter(
    <TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />,
    { route: '/timeline?date=2026-07-31' },
  );
}

describe('TimelineView — the green now-line sits on the account clock', () => {
  it('places the now-line on the wall-clock axis, level with a clip stamped at the same minute', async (ctx) => {
    story(ctx, 'Zgłoszenie z 2026-07-31: zielona przerywana linia stała ~2 h w lewo od najświeższych nagrań. Oś timeline to zegar kamery zapieczętowany jako UTC, a linia brała surowy Date.now() (prawdziwy instant UTC) — czyli rysowała się na innej osi niż wszystko obok. Test przybija kontrakt do rzeczy widocznej dla użytkownika: klip nagrany dokładnie "teraz" i linia "teraz" muszą stać w tym samym miejscu.');
    await mountTimeline();

    const nowLine = await screen.findByTestId('timeline-now');
    const bar = await screen.findByTestId('timeline-bar-ev-now');

    const lineX = Number(nowLine.getAttribute('x1'));
    const barX = Number(bar.getAttribute('x'));

    expect(Number.isFinite(lineX)).toBe(true);
    expect(lineX).toBeGreaterThan(0);
    // Same minute → same pixel column (sub-pixel tolerance for the bar's
    // left-edge vs the line's centre).
    expect(Math.abs(lineX - barX)).toBeLessThan(1);
  });

  it('does not draw the line at the raw UTC instant', async (ctx) => {
    story(ctx, 'Jawny negatywny dowód na dokładnie ten błąd, który zgłoszono. Gdyby ktoś w przyszłości wrócił do Date.now() w tym miejscu, poprzedni test nadal by przechodził przy zerowej szerokości kontenera — ten nie: pilnuje, że linia NIE stoi tam, gdzie stawiał ją surowy instant (offset strefy w lewo).');
    await mountTimeline();

    const nowLine = await screen.findByTestId('timeline-now');
    const lineX = Number(nowLine.getAttribute('x1'));

    // A full UTC day fills the strip, so one hour is width/24 px.
    const pxPerHour = TIMELINE_WIDTH / 24;
    const rawUtcX = 10 * pxPerHour;    // where Date.now() alone would have put it
    const wallClockX = 12 * pxPerHour; // where the account clock puts it

    expect(lineX).toBeCloseTo(wallClockX, 0);
    expect(Math.abs(lineX - rawUtcX)).toBeGreaterThan(pxPerHour);
  });

  it('labels the framed day "today" while the now-line is inside it', async (ctx) => {
    story(ctx, 'Nagłówek i linia "teraz" liczą "dzisiaj" z tego samego źródła (stanu `now`, już przerzuconego na zegar konta). Gdyby się rozjechały, użytkownik dostałby nagłówek "dzisiaj" nad dobą, w której linii teraz w ogóle nie ma — albo odwrotnie, przy tyknięciu przez północ.');
    await mountTimeline();
    await waitFor(() => expect(screen.getByTestId('timeline-now')).toBeTruthy());
    expect(screen.getByText('timeline.today')).toBeTruthy();
  });
});
