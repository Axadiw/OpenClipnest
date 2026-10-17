import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { VideoControls } from './VideoControls';
import { story } from '../test-story';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
  return { video, requestFullscreen, ...utils };
}

beforeEach(() => {
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
