import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test-utils';
import { story } from '../test-story';
import type { CameraEvent } from '../types';
import { LONG_PRESS_MS, PRECISION_FLASH_MS } from './timelineSeek';

// One 30 s clip at 12:00 on the framed day. With the strip at jsdom-style 800 px
// (ResizeObserver never fires) it sits mid-strip, so it's never culled.
const EVENT: Partial<CameraEvent> = {
  id: 'ev-a',
  camera: 'Front',
  timestamp: '2026-07-31T12:00:00.000Z',
  date: '2026-07-31',
  timezone: 'UTC',
  duration: 30,
  views: [{ id: '00', videoRelPath: 'front/00.mp4', sizeBytes: 1024 }],
};

const getEvents = vi.fn();

vi.mock('../api', () => ({
  api: {
    getEvents: (...a: unknown[]) => getEvents(...a),
    getAccountTimezone: () => Promise.resolve({ timezone: 'UTC' }),
    getEventCalendar: () => Promise.resolve({ days: [] }),
    getEvent: (id: string) => Promise.resolve({ event: { id } }),
    getCameras: () => Promise.resolve({ cameras: ['Front'] }),
    getVideoUrl: () => Promise.resolve({ videoUrl: 'blob:video', totalBytes: 1024 }),
    getFrameGrid: () => Promise.resolve([]),
    fetchThumbnailBlob: () => Promise.resolve('blob:thumb'),
  },
  reportPlayback: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock('../i18n', () => ({
  useTranslation: () => ({
    // Echo params so the hint's platform key is assertable.
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
    language: 'en',
  }),
}));

// happy-dom lays nothing out, so give the bar a real box: x 100 → 300 (200 px).
// A press/click at clientX 200 is the bar's middle → 15 s of the 30 s clip.
const MID_X = 200;
function stubBarBox(bar: Element) {
  bar.getBoundingClientRect = () =>
    ({ x: 100, y: 0, left: 100, top: 0, width: 200, height: 28, right: 300, bottom: 28, toJSON: () => ({}) }) as DOMRect;
}

const touch = (clientX: number, pointerId = 1) =>
  ({ pointerId, pointerType: 'touch', isPrimary: pointerId === 1, clientX, clientY: 20 });

const seekOf = () => screen.getByTestId('timeline-inline-video').getAttribute('data-seek-sec');
const badge = () => screen.queryByTestId('timeline-precision-badge');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('clipnest.accountTimezone', 'UTC');
  getEvents.mockImplementation(({ dateFrom }: { dateFrom: string }) =>
    Promise.resolve({ events: dateFrom === EVENT.date ? [EVENT as CameraEvent] : [] }));
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  });
  // Pan / pinch promote to pointer capture; happy-dom may not implement it.
  if (typeof Element.prototype.setPointerCapture !== 'function') {
    Element.prototype.setPointerCapture = () => {};
  }
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse('2026-07-31T13:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountAndGetBar() {
  const { TimelineView } = await import('./TimelineView');
  renderWithRouter(
    <TimelineView cameraFilter={[]} onPlay={() => {}} allCameras={['Front']} />,
    { route: '/timeline?date=2026-07-31' },
  );
  const bar = await screen.findByTestId('timeline-bar-ev-a');
  // findBy resolves on the DOM commit, before React's passive effects run —
  // and the handlers read effect-synced refs (camera list for hover rows,
  // visible events for long-press). A real user can't act within that tick;
  // let the effects flush so the test doesn't either.
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  stubBarBox(bar);
  return bar;
}

// The first mount pays for importing/transforming the whole TimelineView tree
// (~2 s on an idle machine, >5 s under parallel load) — give it headroom.
describe('TimelineView — bar click plays from the start; precision mode seeks', { timeout: 20_000 }, () => {
  it('a plain click in the middle of a bar plays the clip from 0', async (ctx) => {
    story(ctx, 'Zwykły klik w pasek zawsze startuje klip od początku — nawet trafiony w sam środek. Wcześniej klik mapował się proporcjonalnie na czas i user tracił początek zdarzenia.');
    const bar = await mountAndGetBar();
    fireEvent.click(bar, { clientX: MID_X });
    const video = await screen.findByTestId('timeline-inline-video');
    expect(video.getAttribute('data-event-id')).toBe('ev-a');
    expect(seekOf()).toBe('0');
  });

  it('⌘-click and Ctrl-click seek to the clicked point', async (ctx) => {
    story(ctx, 'Tryb precyzyjny z myszą: ⌘-klik (Mac) i Ctrl-klik (reszta) zachowują stare zachowanie — seek do klikniętego miejsca w pasku. Oba klawisze działają wszędzie, żeby klawiatura PC na Macu (i odwrotnie) nie blokowała funkcji.');
    const bar = await mountAndGetBar();
    fireEvent.click(bar, { clientX: MID_X, ctrlKey: true });
    await screen.findByTestId('timeline-inline-video');
    expect(seekOf()).toBe('15');

    fireEvent.click(bar, { clientX: 150, metaKey: true });
    await waitFor(() => expect(seekOf()).toBe('7.5'));
  });

  it('a plain re-click of the playing clip restarts the same <video> from 0', async (ctx) => {
    story(ctx, 'Klik w pasek klipu, który już leci, puszcza go od nowa. Stan (klip, widok, seek 0) jest identyczny, więc player by się nie przemontował i klik nic by nie zrobił — dlatego restart idzie bezpośrednio na żywym <video>.');
    const bar = await mountAndGetBar();
    fireEvent.click(bar, { clientX: MID_X });
    const video = await screen.findByTestId('timeline-inline-video') as HTMLVideoElement;

    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 12 });
    const play = vi.fn(() => Promise.resolve());
    video.play = play;

    fireEvent.click(bar, { clientX: 250 });

    expect(video.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('timeline-inline-video')).toBe(video); // restarted in place, not remounted
  });

  it('a touch long-press seeks to the pressed point, flashes the badge and swallows the tap that ends it', async (ctx) => {
    story(ctx, 'Na dotyku nie ma ⌘/Ctrl — tryb precyzyjny to długie przytrzymanie paska (500 ms). Klip startuje od wskazanego miejsca, telefon lekko wibruje, plakietka „Tryb precyzyjny” miga ~1,5 s, a menu kontekstowe systemu i klik kończący gest nie nadpisują seeka.');
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'vibrate', { configurable: true, writable: true, value: vibrate });
    const bar = await mountAndGetBar();

    fireEvent.pointerDown(bar, touch(MID_X));
    expect(badge()).toBeNull();
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    await screen.findByTestId('timeline-inline-video');
    expect(seekOf()).toBe('15');
    expect(badge()).toBeInTheDocument();
    expect(vibrate).toHaveBeenCalledWith(10);
    // Android's long-press context menu must not pop over the clip.
    expect(fireEvent.contextMenu(bar)).toBe(false);

    // Lifting the finger synthesizes a click — it must not re-open from 0.
    fireEvent.pointerUp(bar, touch(MID_X));
    fireEvent.click(bar, { clientX: MID_X });
    expect(seekOf()).toBe('15');

    act(() => { vi.advanceTimersByTime(PRECISION_FLASH_MS); });
    expect(badge()).toBeNull();
    delete (window.navigator as { vibrate?: unknown }).vibrate;
  });

  it('a quick tap stays an ordinary tap (plays from 0)', async (ctx) => {
    story(ctx, 'Krótkie stuknięcie (puszczone przed 500 ms) to zwykły klik — klip od początku, bez trybu precyzyjnego i bez plakietki.');
    const bar = await mountAndGetBar();
    fireEvent.pointerDown(bar, touch(MID_X));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 200); });
    fireEvent.pointerUp(bar, touch(MID_X));
    fireEvent.click(bar, { clientX: MID_X });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    await screen.findByTestId('timeline-inline-video');
    expect(seekOf()).toBe('0');
    expect(badge()).toBeNull();
    expect(fireEvent.contextMenu(bar)).toBe(true); // nothing to suppress
  });

  it('a finger that travels pans instead of long-pressing', async (ctx) => {
    story(ctx, 'Przesunięcie palca dalej niż próg przeciągania to przewijanie osi, nie przytrzymanie — timer długiego przytrzymania jest anulowany i nic się nie otwiera.');
    const bar = await mountAndGetBar();
    fireEvent.pointerDown(bar, touch(MID_X));
    fireEvent.pointerMove(bar, touch(MID_X + 40));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });
    fireEvent.pointerUp(bar, touch(MID_X + 40));

    expect(badge()).toBeNull();
    expect(screen.getByText('timeline.selectToPlay')).toBeInTheDocument(); // no clip opened
  });

  it('a second finger (pinch) cancels a pending long-press', async (ctx) => {
    story(ctx, 'Drugi palec zamienia gest w pinch-zoom — oczekujące długie przytrzymanie jest anulowane.');
    const bar = await mountAndGetBar();
    fireEvent.pointerDown(bar, touch(MID_X, 1));
    fireEvent.pointerDown(bar, touch(MID_X + 5, 2));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });
    fireEvent.pointerUp(bar, touch(MID_X + 5, 2));
    fireEvent.pointerUp(bar, touch(MID_X, 1));

    expect(badge()).toBeNull();
    expect(screen.getByText('timeline.selectToPlay')).toBeInTheDocument();
  });

  it('holding ⌘/Ctrl with the pointer over the timeline shows the precision indicator', async (ctx) => {
    story(ctx, 'Wskaźnik trybu precyzyjnego (plakietka w toolbarze + celownik nad paskami) świeci tylko, gdy ⌘/Ctrl jest wciśnięty I kursor jest nad osią. Puszczenie klawisza, zjechanie kursorem albo utrata fokusu okna go chowa.');
    const bar = await mountAndGetBar();
    const scroll = screen.getByTestId('timeline-scroll');

    fireEvent.keyDown(document, { key: 'Meta', metaKey: true });
    expect(badge()).toBeNull(); // pointer not over the timeline yet
    fireEvent.mouseEnter(scroll);
    expect(badge()).toBeInTheDocument();
    expect(bar.style.cursor).toBe('crosshair');
    expect(screen.getByTestId('timeline-hover-line').getAttribute('opacity')).toBe('1');

    fireEvent.keyUp(document, { key: 'Meta' });
    expect(badge()).toBeNull();
    expect(bar.style.cursor).toBe('pointer');

    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    expect(badge()).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(badge()).toBeNull();

    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    expect(badge()).toBeInTheDocument();
    fireEvent.mouseLeave(scroll);
    expect(badge()).toBeNull();
  });

  it('bar clicks no longer depend on the bar cursor (crosshair bar still opens its own clip)', async (ctx) => {
    story(ctx, 'Tło osi rozpoznawało kliknięcia w paski po cursor: pointer. W trybie precyzyjnym kursor to crosshair — paski są teraz rozpoznawane po data-event-id, więc ⌘/Ctrl-klik w pasek nie przecieka do obsługi kliknięcia w tło.');
    const bar = await mountAndGetBar();
    const scroll = screen.getByTestId('timeline-scroll');
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(scroll);
    expect(bar.style.cursor).toBe('crosshair');

    fireEvent.click(bar, { clientX: MID_X, ctrlKey: true });
    await screen.findByTestId('timeline-inline-video');
    expect(seekOf()).toBe('15');
  });

  it('the hover tooltip hints the platform modifier over a bar (fine pointers)', async (ctx) => {
    story(ctx, 'Odkrywalność: na urządzeniach z myszą tooltip nad paskiem podpowiada „⌘+klik: odtwórz od tego miejsca” (na Macu ⌘, gdzie indziej Ctrl).');
    // Same stubbing idiom as useTheme.test.ts — vi.stubGlobal does not reach
    // the happy-dom `window` the component reads.
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() {}, removeEventListener() {} }),
    });
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' });
    try {
      await mountAndGetBar();
      const scroll = screen.getByTestId('timeline-scroll');

      // Layout-less DOM: the scroll box sits at 0,0, so clientX 400 of 800 px
      // is 12:00 (the clip) and clientY 20 is row 0 (camera "Front").
      fireEvent.mouseMove(scroll, { clientX: 400, clientY: 20 });
      const hint = await screen.findByTestId('timeline-tooltip-hint');
      expect(hint.textContent).toBe('timeline.precisionHint:⌘');
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia });
      delete (window.navigator as { platform?: unknown }).platform;
    }
  });
});
