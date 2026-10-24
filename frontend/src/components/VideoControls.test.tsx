import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { VideoControls } from './VideoControls';
import { story } from '../test-story';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The preview hook owns a hidden <video> and canvas painting, which happy-dom can't run. It is
// replaced by a stand-in that keeps the same state shape, so the bar's pointer rules and the real
// bubble component are what these tests exercise.
const preview = vi.hoisted(() => ({ show: [] as number[], hide: 0, index: null as unknown, total: 0 }));
const scrubClient = vi.hoisted(() => ({ subscribed: 0, unsubscribed: 0, emit: null as null | ((r: { total: number; ranges: { start: number; end: number }[] }) => void) }));
vi.mock('../lib/scrubCache/client', () => ({
  isScrubCacheActive: () => true,
  subscribeCachedRanges: (_url: string, cb: (r: { total: number; ranges: { start: number; end: number }[] }) => void) => {
    scrubClient.emit = cb;
    scrubClient.subscribed++;
    return () => { scrubClient.emit = null; scrubClient.unsubscribed++; };
  },
}));
vi.mock('../hooks/useScrubPreview', async () => {
  const { useState, useRef, useCallback } = await import('react');
  return {
    useScrubPreview: (videoRef: { current: { duration: number } | null }) => {
      const [state, setState] = useState<'hidden' | 'loading' | 'ready'>('hidden');
      const [fraction, setFraction] = useState(0);
      const canvasRef = useRef<HTMLCanvasElement | null>(null);
      const show = useCallback((f: number) => {
        preview.show.push(f);
        setFraction(f);
        setState('loading');
      }, []);
      const hide = useCallback(() => { preview.hide++; setState('hidden'); }, []);
      const duration = videoRef.current?.duration ?? 0;
      return { state, time: fraction * duration, fraction, canvasRef, show, hide, sampleIndex: preview.index, sampleTotal: preview.total };
    },
  };
});

// happy-dom can't decode real media, so the <video> element is faked. Only
// the element is faked — the component's listeners, handlers and rendering
// (the actual unit under test) are real.
class FakeVideo extends EventTarget {
  paused = true;
  duration = 0;
  currentTime = 0;
  volume = 1;
  muted = false;
  playbackRate = 1;
  buffered: TimeRanges = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
  play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('play')); });
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')); });
  requestPictureInPicture = vi.fn(async () => ({}));
}

function setup(overrides: Partial<FakeVideo> = {}) {
  const video = Object.assign(new FakeVideo(), overrides);
  const videoRef = createRef<HTMLVideoElement>();
  (videoRef as { current: unknown }).current = video;

  const container = document.createElement('div');
  const requestFullscreen = vi.fn(async () => {});
  Object.defineProperty(container, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  const containerRef = createRef<HTMLElement>();
  (containerRef as { current: unknown }).current = container;

  const utils = render(<VideoControls videoRef={videoRef} containerRef={containerRef} />);
  return { video, requestFullscreen, ...utils, playerContainer: container };
}

beforeEach(() => {
  preview.show.length = 0;
  preview.hide = 0;
  preview.index = null;
  preview.total = 0;
  scrubClient.subscribed = 0;
  scrubClient.unsubscribed = 0;
  scrubClient.emit = null;
  localStorage.clear();
  (document as unknown as { pictureInPictureEnabled: boolean }).pictureInPictureEnabled = true;
});

describe('VideoControls', () => {
  it('plays a paused video and reflects the playing state', (ctx) => {
    story(ctx, 'Użytkownik klika zielony przycisk play na własnym pasku sterowania — film rusza, a przycisk zmienia się w pauzę, więc widać, że odtwarzanie trwa.');
    const { video } = setup({ paused: true, duration: 8 });
    const btn = screen.getByTestId('player-playpause');
    expect(btn.getAttribute('aria-label')).toBe('player.play');
    fireEvent.click(btn);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('aria-label')).toBe('player.pause');
  });

  it('pauses a playing video', (ctx) => {
    story(ctx, 'Gdy film leci, kliknięcie przycisku go zatrzymuje — sterowanie odtwarzaniem działa w obie strony.');
    const { video } = setup({ paused: false, duration: 8 });
    const btn = screen.getByTestId('player-playpause');
    fireEvent.click(btn);
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it('shows current and total time and updates on timeupdate', (ctx) => {
    story(ctx, 'Pasek pokazuje aktualną i całkowitą długość nagrania (np. 0:04 / 0:08) i odlicza w trakcie odtwarzania, więc użytkownik wie, gdzie jest w klipie.');
    const { video } = setup({ duration: 8, currentTime: 0 });
    const time = screen.getByTestId('player-time');
    expect(time.textContent).toContain('0:00');
    expect(time.textContent).toContain('0:08');
    act(() => { video.currentTime = 4; video.dispatchEvent(new Event('timeupdate')); });
    expect(time.textContent).toContain('0:04');
  });

  it('seeks to the clicked fraction of the seek bar', (ctx) => {
    story(ctx, 'Kliknięcie w środek zielonego paska przewijania przeskakuje film do połowy — przewijanie myszą działa jak w natywnym odtwarzaczu.');
    const { video } = setup({ duration: 8 });
    const seek = screen.getByTestId('player-seek');
    seek.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 5, right: 100, bottom: 5, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(seek, { clientX: 50 });
    expect(video.currentTime).toBeCloseTo(4, 5);
  });

  it('toggles mute and persists the choice', (ctx) => {
    story(ctx, 'Wyciszenie z paska zapamiętuje się między klipami — użytkownik nie musi wyciszać każdego nagrania od nowa.');
    const { video } = setup({ duration: 8, muted: false });
    const btn = screen.getByTestId('player-mute');
    expect(btn.getAttribute('aria-label')).toBe('player.mute');
    fireEvent.click(btn);
    expect(video.muted).toBe(true);
    expect(localStorage.getItem('clipnest.player.muted')).toBe('true');
  });

  it('changes and persists volume from the volume slider', (ctx) => {
    story(ctx, 'Suwak głośności od razu zmienia poziom dźwięku i zapamiętuje go, więc kolejne klipy grają na tym samym poziomie.');
    const { video } = setup({ duration: 8 });
    fireEvent.change(screen.getByTestId('player-volume'), { target: { value: '0.5' } });
    expect(video.volume).toBeCloseTo(0.5, 5);
    expect(localStorage.getItem('clipnest.player.volume')).toBe('0.5');
  });

  it('restores persisted volume and mute on mount', (ctx) => {
    story(ctx, 'Po wejściu w kolejne nagranie odtwarzacz przywraca wcześniej ustawioną głośność i wyciszenie — preferencje dźwięku są trwałe.');
    localStorage.setItem('clipnest.player.volume', '0.3');
    localStorage.setItem('clipnest.player.muted', 'true');
    const { video } = setup({ duration: 8 });
    expect(video.volume).toBeCloseTo(0.3, 5);
    expect(video.muted).toBe(true);
  });

  it('changes playback speed from the speed menu', (ctx) => {
    story(ctx, 'Z menu prędkości użytkownik wybiera np. 2× i nagranie przyspiesza — przydatne przy szybkim przeglądaniu długich klipów z kamery.');
    const { video } = setup({ duration: 8 });
    fireEvent.click(screen.getByTestId('player-speed'));
    fireEvent.click(screen.getByTestId('player-speed-2'));
    expect(video.playbackRate).toBe(2);
  });

  it('requests picture-in-picture', (ctx) => {
    story(ctx, 'Przycisk PiP wypycha wideo do małego pływającego okienka — użytkownik może oglądać nagranie, pracując w innej karcie.');
    const { video } = setup({ duration: 8 });
    fireEvent.click(screen.getByTestId('player-pip'));
    expect(video.requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it('requests fullscreen on the container, not the video', (ctx) => {
    story(ctx, 'Pełny ekran obejmuje cały kontener odtwarzacza (a nie sam element wideo), dzięki czemu nasz zielony pasek pozostaje widoczny także na pełnym ekranie.');
    const { requestFullscreen } = setup({ duration: 8 });
    fireEvent.click(screen.getByTestId('player-fullscreen'));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('continues seeking while dragging across the seek bar', (ctx) => {
    story(ctx, 'Przeciąganie uchwytu po pasku płynnie przewija nagranie — nie trzeba klikać w punkty, można scrubować jak w prawdziwym odtwarzaczu.');
    const { video } = setup({ duration: 8 });
    const seek = screen.getByTestId('player-seek');
    seek.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 5, right: 100, bottom: 5, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(seek, { clientX: 50 });
    expect(video.currentTime).toBeCloseTo(4, 5);
    fireEvent.pointerMove(window, { clientX: 25 });
    expect(video.currentTime).toBeCloseTo(2, 5);
    fireEvent.pointerUp(window, { clientX: 25 });
  });

  it('toggles play/pause with the Space key', (ctx) => {
    story(ctx, 'Spacja startuje i zatrzymuje odtwarzanie bez sięgania do paska — standardowy skrót, którego użytkownicy oczekują od odtwarzacza wideo.');
    const { video } = setup({ paused: true, duration: 8 });
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('toggles play/pause when the video itself is clicked (native parity)', (ctx) => {
    story(ctx, 'Kliknięcie w sam obraz wideo startuje i zatrzymuje odtwarzanie — tak jak w natywnym odtwarzaczu; użytkownik nie musi celować w mały przycisk na pasku.');
    const { video } = setup({ paused: true, duration: 8 });
    act(() => { video.dispatchEvent(new Event('click')); });
    expect(video.play).toHaveBeenCalledTimes(1);
    act(() => { video.dispatchEvent(new Event('click')); });
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it('reports chrome visibility to the parent so the zoom/frame-step controls hide together', (ctx) => {
    story(ctx, 'Gdy po paru sekundach odtwarzania pasek sterowania znika, odtwarzacz zgłasza to rodzicowi — dzięki czemu razem z paskiem chowają się też przyciski klatka-po-klatce i zoomu (a nie wiszą samotnie na ekranie).');
    vi.useFakeTimers();
    try {
      const onChromeVisibleChange = vi.fn();
      const video = Object.assign(new FakeVideo(), { paused: false, duration: 8 });
      const videoRef = createRef<HTMLVideoElement>();
      (videoRef as { current: unknown }).current = video;
      const container = document.createElement('div');
      const containerRef = createRef<HTMLElement>();
      (containerRef as { current: unknown }).current = container;

      render(
        <VideoControls
          videoRef={videoRef}
          containerRef={containerRef}
          onChromeVisibleChange={onChromeVisibleChange}
        />,
      );

      // Initially visible.
      expect(onChromeVisibleChange).toHaveBeenLastCalledWith(true);

      // A pointer move while playing arms the hide timer; after the delay the
      // bar hides and the parent is told so it can hide the zoom controls too.
      act(() => { container.dispatchEvent(new Event('pointermove')); });
      act(() => { vi.advanceTimersByTime(3000); });
      expect(onChromeVisibleChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a buffering spinner on mid-playback stalls and hides it on resume', (ctx) => {
    story(ctx, 'Gdy w trakcie odtwarzania zabraknie zbuforowanych danych, na pasku pojawia się mała kręciołka zamiast znikającego natywnego wskaźnika — użytkownik widzi, że odtwarzacz dobiera dane, a nie że się zawiesił.');
    const { video } = setup({ paused: false, duration: 8 });
    expect(screen.queryByTestId('player-buffering')).toBeNull();
    act(() => { video.dispatchEvent(new Event('waiting')); });
    expect(screen.getByTestId('player-buffering')).toBeInTheDocument();
    act(() => { video.dispatchEvent(new Event('playing')); });
    expect(screen.queryByTestId('player-buffering')).toBeNull();
  });
});

describe('VideoControls scrub preview', () => {
  function setupBar() {
    const utils = setup({ duration: 100, paused: false });
    const seek = screen.getByTestId('player-seek');
    seek.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 5, right: 100, bottom: 5, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return { ...utils, seek };
  }

  it('mouse hover shows the bubble with the hovered time and does not seek', (ctx) => {
    story(ctx, 'Najechanie myszą na pasek przewijania pokazuje dymek z czasem (np. 1:15) i podglądem klatki z tego miejsca — film dalej gra tam, gdzie grał.');
    const { video, seek } = setupBar();
    fireEvent.pointerMove(seek, { pointerType: 'mouse', buttons: 0, clientX: 75 });
    expect(screen.getByTestId('player-seek-preview-time').textContent).toBe('1:15');
    expect(screen.getByTestId('player-seek-preview').getAttribute('data-state')).toBe('loading');
    expect(video.currentTime).toBe(0);
  });

  it('pointer leave hides the bubble', (ctx) => {
    story(ctx, 'Gdy kursor zjedzie z paska, dymek z podglądem znika.');
    const { seek } = setupBar();
    fireEvent.pointerMove(seek, { pointerType: 'mouse', buttons: 0, clientX: 40 });
    expect(screen.getByTestId('player-seek-preview')).toBeInTheDocument();
    fireEvent.pointerLeave(seek, { pointerType: 'mouse' });
    expect(screen.queryByTestId('player-seek-preview')).toBeNull();
  });

  it('touch drag shows the bubble and seeks only on release', (ctx) => {
    story(ctx, 'Na telefonie przeciąganie uchwytu pokazuje dymek z podglądem, a film gra dalej; dopiero po puszczeniu palca odtwarzanie przeskakuje w wybrane miejsce.');
    const { video, seek } = setupBar();
    fireEvent.pointerDown(seek, { pointerType: 'touch', clientX: 20 });
    expect(video.currentTime).toBe(0);
    expect(screen.getByTestId('player-seek-preview-time').textContent).toBe('0:20');
    fireEvent.pointerMove(window, { pointerType: 'touch', clientX: 60 });
    expect(screen.getByTestId('player-seek-preview-time').textContent).toBe('1:00');
    expect(video.currentTime).toBe(0);
    fireEvent.pointerUp(window, { pointerType: 'touch', clientX: 60 });
    expect(video.currentTime).toBeCloseTo(60, 1);
    expect(screen.queryByTestId('player-seek-preview')).toBeNull();
  });

  it('touch pointercancel does not seek', (ctx) => {
    story(ctx, 'Jeśli system przerwie gest (np. przewijanie strony), podgląd znika, a film nie przeskakuje.');
    const { video, seek } = setupBar();
    fireEvent.pointerDown(seek, { pointerType: 'touch', clientX: 20 });
    fireEvent.pointerMove(window, { pointerType: 'touch', clientX: 60 });
    fireEvent.pointerCancel(window, { pointerType: 'touch' });
    expect(video.currentTime).toBe(0);
    expect(screen.queryByTestId('player-seek-preview')).toBeNull();
    fireEvent.pointerUp(window, { pointerType: 'touch', clientX: 60 });
    expect(video.currentTime).toBe(0);
  });

  it('mouse drag keeps live seek', (ctx) => {
    story(ctx, 'Przeciąganie myszą nadal przewija film na żywo, bez dymka — zachowanie z komputera się nie zmienia.');
    const { video, seek } = setupBar();
    fireEvent.pointerMove(seek, { pointerType: 'mouse', buttons: 0, clientX: 30 });
    fireEvent.pointerDown(seek, { pointerType: 'mouse', clientX: 30 });
    expect(video.currentTime).toBeCloseTo(30, 5);
    expect(screen.queryByTestId('player-seek-preview')).toBeNull();
    fireEvent.pointerMove(seek, { pointerType: 'mouse', buttons: 1, clientX: 50 });
    expect(screen.queryByTestId('player-seek-preview')).toBeNull();
    fireEvent.pointerUp(window, { pointerType: 'mouse', clientX: 50 });
  });
  it('keeps the bar and bubble up while a mouse rests on the bar, then auto-hides after leave', (ctx) => {
    story(ctx, 'Gdy użytkownik zatrzyma kursor na pasku, żeby obejrzeć podgląd, pasek i dymek nie znikają po 2,5 s; po zjechaniu kursorem pasek znów chowa się sam.');
    vi.useFakeTimers();
    try {
      const { seek, playerContainer } = setupBar();
      act(() => { playerContainer.dispatchEvent(new Event('pointerenter')); });
      fireEvent.pointerMove(seek, { pointerType: 'mouse', buttons: 0, clientX: 40 });
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByTestId('player-controls').className).not.toContain('video-controls-hidden');
      expect(screen.getByTestId('player-seek-preview')).toBeInTheDocument();
      fireEvent.pointerLeave(seek, { pointerType: 'mouse' });
      expect(screen.queryByTestId('player-seek-preview')).toBeNull();
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByTestId('player-controls').className).toContain('video-controls-hidden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the bar and bubble up while a finger holds the knob, then auto-hides after release', (ctx) => {
    story(ctx, 'Palec przytrzymany na uchwycie dłużej niż 2,5 s nie powoduje zniknięcia paska ani dymka; po puszczeniu film przeskakuje, a pasek wraca do zwykłego chowania się.');
    vi.useFakeTimers();
    try {
      const { video, seek } = setupBar();
      fireEvent.pointerDown(seek, { pointerType: 'touch', clientX: 20 });
      fireEvent.pointerMove(window, { pointerType: 'touch', clientX: 50 });
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByTestId('player-controls').className).not.toContain('video-controls-hidden');
      expect(screen.getByTestId('player-seek-preview')).toBeInTheDocument();
      fireEvent.pointerUp(window, { pointerType: 'touch', clientX: 50 });
      expect(video.currentTime).toBeCloseTo(50, 1);
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByTestId('player-controls').className).toContain('video-controls-hidden');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VideoControls cached stretches', () => {
  function mount() {
    // 30 samples of 100 bytes each, 3 s long; the file is 4000 bytes.
    const n = 30;
    preview.total = 4000;
    preview.index = {
      pts: Float64Array.from({ length: n }, (_, i) => i / 10),
      offset: Float64Array.from({ length: n }, (_, i) => 1000 + i * 100),
      size: Uint32Array.from({ length: n }, () => 100),
      keyframes: Uint32Array.from([0, 20]),
      duration: 3,
      trackSpans: { dts: new Float64Array(0), start: new Float64Array(0), end: new Float64Array(0) },
    };
    const video = Object.assign(new FakeVideo(), { duration: 3 }) as FakeVideo & { currentSrc: string };
    video.currentSrc = '/api/v0/events/abc/video/00?media_token=T&fmt=clean';
    const videoRef = createRef<HTMLVideoElement>();
    (videoRef as { current: unknown }).current = video;
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: unknown }).current = document.createElement('div');
    render(<VideoControls videoRef={videoRef} containerRef={containerRef} />);
    return video;
  }

  it('renders a grey segment for cached ranges that video.buffered lacks', (ctx) => {
    story(ctx, 'Fragment nagrania pobrany tylko przez podgląd po najechaniu myszą jest od razu szary na pasku, choć film nigdy tam nie grał; reszta paska zostaje bez zacieniowania.');
    mount();
    expect(screen.queryAllByTestId('player-seek-buffered')).toHaveLength(0);
    act(() => { scrubClient.emit?.({ total: 4000, ranges: [{ start: 3000, end: 4000 }] }); });
    const segs = screen.getAllByTestId('player-seek-buffered');
    expect(segs).toHaveLength(1);
    expect(parseFloat((segs[0] as HTMLElement).style.left)).toBeCloseTo(66.67, 1);
  });

  it('paints nothing when the cached bytes belong to a file of another size', (ctx) => {
    story(ctx, 'Jeśli pamięć podręczna trzyma bajty innej wersji pliku niż ta, z której odczytano układ nagrania, pasek nie zaznacza niczego na szaro.');
    mount();
    act(() => { scrubClient.emit?.({ total: 5000, ranges: [{ start: 3000, end: 4000 }] }); });
    expect(screen.queryAllByTestId('player-seek-buffered')).toHaveLength(0);
    act(() => { scrubClient.emit?.({ total: 0, ranges: [{ start: 3000, end: 4000 }] }); });
    expect(screen.queryAllByTestId('player-seek-buffered')).toHaveLength(0);
  });

  it('keeps the subscription and the grey segments when only the media token changes', (ctx) => {
    story(ctx, 'Odświeżenie tokenu w adresie wideo nie powoduje mignięcia szarych odcinków na pasku.');
    const video = mount();
    act(() => { scrubClient.emit?.({ total: 4000, ranges: [{ start: 3000, end: 4000 }] }); });
    expect(scrubClient.subscribed).toBe(1);
    video.currentSrc = '/api/v0/events/abc/video/00?media_token=T2&fmt=clean';
    act(() => { video.dispatchEvent(new Event('loadstart')); });
    expect(scrubClient.subscribed).toBe(1);
    expect(scrubClient.unsubscribed).toBe(0);
    expect(screen.getAllByTestId('player-seek-buffered')).toHaveLength(1);
  });

  it('clears the grey segments when the worker reports the bytes are gone', (ctx) => {
    story(ctx, 'Gdy service worker został zatrzymany lub zastąpiony nową wersją i stracił pamięć, szare odcinki pobrane tylko przez podgląd znikają z paska.');
    mount();
    act(() => { scrubClient.emit?.({ total: 4000, ranges: [{ start: 3000, end: 4000 }] }); });
    expect(screen.getAllByTestId('player-seek-buffered')).toHaveLength(1);
    act(() => { scrubClient.emit?.({ total: 0, ranges: [] }); });
    expect(screen.queryAllByTestId('player-seek-buffered')).toHaveLength(0);
  });
});
