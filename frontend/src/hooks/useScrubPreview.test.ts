import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useScrubPreview } from './useScrubPreview';
import { story } from '../test-story';
import { isScrubCacheActive, subscribeCachedRanges, onScrubCacheWipe, refreshCachedRanges } from '../lib/scrubCache/client';
import { loadSampleIndex, prefetchWindow, sampleIndexTotal } from '../lib/scrubPreview/sampleIndexLoader';
import type { SampleIndex } from '../lib/mp4/sampleTable';

vi.mock('../lib/scrubCache/client', () => ({
  isScrubCacheActive: vi.fn(() => false),
  subscribeCachedRanges: vi.fn(() => () => {}),
  prefetchRange: vi.fn(async () => true),
  onScrubCacheWipe: vi.fn(() => () => {}),
  refreshCachedRanges: vi.fn(),
}));
vi.mock('../lib/scrubPreview/sampleIndexLoader', () => ({
  PREVIEW_AHEAD_SEC: 5,
  sampleIndexTotal: vi.fn(() => 4242),
  loadSampleIndex: vi.fn(async () => null),
  prefetchWindow: vi.fn(async () => {}),
}));

const URL_T1 = '/api/v0/events/abc/video/00?media_token=T1&fmt=clean';
const URL_T2 = '/api/v0/events/abc/video/00?media_token=T2&fmt=clean';
const URL_OTHER = '/api/v0/events/xyz/video/00?media_token=T1&fmt=clean';

/** `n` one-sample-per-`step` video samples of 1000 bytes each, back to back; keyframes as given. */
function index(n: number, keyframes: number[], step = 1): SampleIndex {
  const pts = Float64Array.from({ length: n }, (_, i) => i * step);
  return {
    duration: n * step,
    pts,
    offset: Float64Array.from({ length: n }, (_, i) => i * 1000),
    size: new Uint32Array(n).fill(1000),
    keyframes: Uint32Array.from(keyframes),
    trackSpans: { dts: pts, start: new Float64Array(n), end: new Float64Array(n) },
  };
}

/** Worker reports these ranges (of a file of `total` bytes) to every subscriber at once. */
function workerHolds(total: number, ranges: Array<{ start: number; end: number }>) {
  vi.mocked(isScrubCacheActive).mockReturnValue(true);
  vi.mocked(sampleIndexTotal).mockReturnValue(total);
  vi.mocked(subscribeCachedRanges).mockImplementation((_url, cb) => { cb({ total, ranges }); return () => {}; });
}

/** Draws onto the bubble's canvas (frame copies for the cache go through createImageBitmap). */
const draws = () => drawImage.mock.calls.length;

type FrameCb = (now: number, meta: { mediaTime: number }) => void;
interface PreviewProbe {
  el: HTMLVideoElement;
  seeks: number[];
  /** Presents a frame to every pending frame callback, then fires `seeked`. */
  completeSeek(mediaTime: number): void;
}

let previews: PreviewProbe[] = [];
let drawImage: ReturnType<typeof vi.fn>;
const origCreate = document.createElement.bind(document);

function patchPreview(el: HTMLVideoElement): PreviewProbe {
  const seeks: number[] = [];
  let time = 0;
  let nextId = 1;
  const callbacks = new Map<number, FrameCb>();
  Object.defineProperty(el, 'readyState', { configurable: true, get: () => 1 });
  Object.defineProperty(el, 'duration', { configurable: true, get: () => 100 });
  Object.defineProperty(el, 'videoWidth', { configurable: true, get: () => 320 });
  Object.defineProperty(el, 'videoHeight', { configurable: true, get: () => 180 });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (v: number) => { time = v; seeks.push(v); },
  });
  Object.defineProperty(el, 'load', { configurable: true, value: vi.fn() });
  Object.defineProperty(el, 'requestVideoFrameCallback', {
    configurable: true,
    value: (cb: FrameCb) => { const id = nextId++; callbacks.set(id, cb); return id; },
  });
  Object.defineProperty(el, 'cancelVideoFrameCallback', {
    configurable: true,
    value: (id: number) => { callbacks.delete(id); },
  });
  return {
    el,
    seeks,
    completeSeek(mediaTime: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const cb of pending) cb(0, { mediaTime });
      el.dispatchEvent(new Event('seeked'));
    },
  };
}

function mainVideo(src = URL_T1) {
  return { duration: 100, currentSrc: src, src, addEventListener() {}, removeEventListener() {} } as unknown as HTMLVideoElement;
}

function setup(main = mainVideo()) {
  const videoRef = { current: main } as RefObject<HTMLVideoElement | null>;
  const hook = renderHook(({ k }) => useScrubPreview(videoRef, k), { initialProps: { k: 1 as unknown } });
  const canvas = origCreate('canvas');
  (hook.result.current.canvasRef as { current: HTMLCanvasElement | null }).current = canvas;
  return { hook, main };
}

beforeEach(() => {
  vi.useFakeTimers();
  previews = [];
  drawImage = vi.fn();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    const el = origCreate(tag, opts);
    if (tag === 'video') previews.push(patchPreview(el as HTMLVideoElement));
    return el;
  }) as typeof document.createElement);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ({ drawImage })) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  vi.mocked(isScrubCacheActive).mockReturnValue(false);
  vi.mocked(loadSampleIndex).mockResolvedValue(null);
  vi.mocked(prefetchWindow).mockReset();
  vi.mocked(prefetchWindow).mockResolvedValue(undefined);
  vi.mocked(sampleIndexTotal).mockReturnValue(4242);
  vi.mocked(subscribeCachedRanges).mockImplementation(() => () => {});
  vi.mocked(onScrubCacheWipe).mockImplementation(() => () => {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 160, height: 90, close: vi.fn() })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useScrubPreview', () => {
  it('asks the worker for its current cached ranges each time the bubble opens', (ctx) => {
    story(ctx, 'Po otwarciu dymka podglądu strona od razu pyta service workera, co naprawdę ma w pamięci, więc szare odcinki po restarcie workera nie udają już pobranych.');
    const { hook } = setup();
    vi.mocked(refreshCachedRanges).mockClear();
    act(() => hook.result.current.show(0.25));
    act(() => hook.result.current.show(0.3));
    expect(refreshCachedRanges).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.hide());
    act(() => hook.result.current.show(0.4));
    expect(refreshCachedRanges).toHaveBeenCalledTimes(2);
  });

  it('shows the time immediately with state loading', (ctx) => {
    story(ctx, 'Zanim podgląd klatki się wczyta, dymek od razu pokazuje czas miejsca pod kursorem (przygaszony obraz = ładowanie).');
    const { hook } = setup();
    expect(hook.result.current.state).toBe('hidden');
    act(() => hook.result.current.show(0.25));
    expect(hook.result.current.state).toBe('loading');
    expect(hook.result.current.time).toBeCloseTo(25, 5);
    expect(hook.result.current.fraction).toBeCloseTo(0.25, 5);
    act(() => hook.result.current.hide());
    expect(hook.result.current.state).toBe('hidden');
  });

  it('preview works without a controller', async (ctx) => {
    story(ctx, 'Bez aktywnego service workera (pierwsza wizyta, tryb prywatny) podgląd i tak działa: ukryty odtwarzacz sam pobiera klatkę i pokazuje ją w dymku.');
    const { hook } = setup();
    act(() => hook.result.current.show(0.3));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const pv = previews[0];
    expect(pv).toBeDefined();
    expect(pv.seeks).toEqual([30]);
    await act(async () => { pv.completeSeek(30); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.state).toBe('ready');
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(prefetchWindow).not.toHaveBeenCalled();
  });

  it('follows a moving pointer: a frame finishing after the pointer moved on stands in, then the latest spot runs', async (ctx) => {
    story(ctx, 'Podczas przesuwania kursora podgląd nie czeka, aż kursor stanie: klatka dla poprzedniego miejsca pokazuje się, gdy tylko się wczyta, a zaraz po niej ładuje się klatka spod kursora. Daleka klatka (ponad 2 s od kursora) jest przygaszona.');
    const { hook } = setup();
    act(() => hook.result.current.show(0.1));
    const pv = previews[0];
    expect(pv.seeks).toEqual([10]); // no settle delay
    act(() => hook.result.current.show(0.9));
    await act(async () => { pv.completeSeek(10); await vi.advanceTimersByTimeAsync(0); });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state).toBe('loading'); // 10 s is far from 90 s
    expect(pv.seeks.at(-1)).toBe(90);
    await act(async () => { pv.completeSeek(90); await vi.advanceTimersByTimeAsync(0); });
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toBe('ready');
    expect(hook.result.current.time).toBeCloseTo(90, 5);
  });

  it('a frame trailing the pointer by under 2 s is shown live, not dimmed', async (ctx) => {
    story(ctx, 'Przy płynnym przesuwaniu klatka spóźniona o ułamek sekundy względem kursora nie jest wyszarzana — dymek wygląda na aktualny przez cały ruch.');
    const { hook } = setup();
    act(() => hook.result.current.show(0.3));
    const pv = previews[0];
    act(() => hook.result.current.show(0.31));
    await act(async () => { pv.completeSeek(30); await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.state).toBe('ready');
    expect(pv.seeks.at(-1)).toBe(31);
  });

  it('never draws a frame whose mediaTime does not match the target', async (ctx) => {
    story(ctx, 'Przeglądarka potrafi po pierwszym przewinięciu pokazać starą klatkę z początku nagrania; podgląd wtedy ponawia przewinięcie i nigdy nie rysuje klatki z innego miejsca niż wskazane.');
    const { hook } = setup();
    act(() => hook.result.current.show(0.5));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const pv = previews[0];
    await act(async () => { pv.completeSeek(0); await vi.advanceTimersByTimeAsync(1000); });
    expect(drawImage).not.toHaveBeenCalled();
    expect(pv.seeks).toEqual([50, 50]); // retried once
    await act(async () => { pv.completeSeek(0); await vi.advanceTimersByTimeAsync(1000); });
    expect(drawImage).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe('loading');
  });

  it('a stale first frame is retried and the right one drawn', async (ctx) => {
    story(ctx, 'Jeśli pierwsza klatka była nieaktualna, ponowione przewinięcie daje już właściwą klatkę i to ona trafia do dymka.');
    const { hook } = setup();
    act(() => hook.result.current.show(0.5));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const pv = previews[0];
    await act(async () => { pv.completeSeek(0); await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { pv.completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state).toBe('ready');
  });

  it('refreshes the preview src from currentSrc on each show', (ctx) => {
    story(ctx, 'Gdy token wideo się odświeży, podgląd przy następnym najechaniu korzysta już z nowego adresu, więc nie trafia na wygasły link.');
    const { hook, main } = setup();
    act(() => hook.result.current.show(0.2));
    const pv = previews[0];
    expect(pv.el.src).toContain('media_token=T1');
    expect(pv.el.src).toContain('scrub=1');
    act(() => hook.result.current.hide());
    (main as unknown as { currentSrc: string }).currentSrc = URL_T2;
    act(() => hook.result.current.show(0.4));
    expect(previews).toHaveLength(1);
    expect(pv.el.src).toContain('media_token=T2');
    expect(pv.el.src).toContain('scrub=1');
  });

  it('loads the sample index on mount when the worker is active, without any hover', async (ctx) => {
    story(ctx, 'Gdy service worker działa, pasek zna układ nagrania od razu po otwarciu odtwarzacza, więc szare odcinki widać jeszcze zanim użytkownik najedzie na pasek.');
    const ix = { duration: 100, pts: new Float64Array([0, 30, 60]) } as unknown as SampleIndex;
    vi.mocked(isScrubCacheActive).mockReturnValue(true);
    vi.mocked(loadSampleIndex).mockResolvedValue(ix);
    const { hook } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.mocked(loadSampleIndex)).toHaveBeenCalledTimes(1);
    expect(hook.result.current.sampleIndex).toBe(ix);
    expect(hook.result.current.sampleTotal).toBe(4242);
  });

  it('prefetches the window through the worker before seeking', async (ctx) => {
    story(ctx, 'Gdy service worker działa, podgląd najpierw dociąga do pamięci kawałek nagrania wokół wskazanego miejsca — po kliknięciu tam film rusza bez ponownego pobierania.');
    const ix = index(3, [0, 2], 30);
    vi.mocked(isScrubCacheActive).mockReturnValue(true);
    vi.mocked(loadSampleIndex).mockResolvedValue(ix);
    const { hook } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.sampleIndex).toBe(ix);
    act(() => hook.result.current.show(0.6));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(prefetchWindow).toHaveBeenCalledTimes(1);
    const [url, gotIx, t, , , aheadSec] = vi.mocked(prefetchWindow).mock.calls[0];
    expect(url).toContain('scrub=1');
    expect(gotIx).toBe(ix);
    expect(t).toBeCloseTo(60, 5);
    expect(aheadSec).toBe(0); // only this frame's bytes while the pointer moves
    expect(previews[0].seeks).toEqual([60]);
  });

  it('detaches the preview element on unmount', (ctx) => {
    story(ctx, 'Po zamknięciu odtwarzacza ukryty element podglądu jest usuwany i nie pobiera już nic w tle.');
    const { hook } = setup();
    act(() => hook.result.current.show(0.2));
    const pv = previews[0];
    expect(pv.el.isConnected).toBe(true);
    hook.unmount();
    expect(pv.el.isConnected).toBe(false);
    expect(pv.el.getAttribute('src')).toBeNull();
  });

  describe('instant preview over buffered stretches', () => {
    it('a frame whose bytes are cached is seeked at once, with no settle delay and no prefetch', async (ctx) => {
      story(ctx, 'Gdy fragment nagrania jest już w pamięci (szary odcinek paska), podgląd nie czeka 200 ms na zatrzymanie kursora, tylko od razu szuka klatki — i nic nie pobiera z sieci.');
      const ix = index(100, [0, 50]);
      workerHolds(100_000, [{ start: 0, end: 100_000 }]);
      vi.mocked(loadSampleIndex).mockResolvedValue(ix);
      const { hook } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.5));
      await act(async () => { await Promise.resolve(); });
      const pv = previews[0];
      expect(pv.seeks).toEqual([50]); // 50 is a keyframe: no keyframe step
      expect(prefetchWindow).not.toHaveBeenCalled();
      await act(async () => { pv.completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
      expect(hook.result.current.state).toBe('ready');
    });

    it('a frame whose bytes are not cached is fetched at once, one fetch at a time', async (ctx) => {
      story(ctx, 'Gdy wskazanego fragmentu nie ma w pamięci, podgląd od razu pobiera bajty tej jednej klatki — bez czekania na zatrzymanie kursora. Naraz trwa najwyżej jedno takie pobieranie, a kolejne bierze najnowsze miejsce spod kursora.');
      const ix = index(100, [0, 50]);
      workerHolds(100_000, [{ start: 0, end: 10_000 }]);
      vi.mocked(loadSampleIndex).mockResolvedValue(ix);
      const pending: Array<() => void> = [];
      vi.mocked(prefetchWindow).mockImplementation(() => new Promise<void>((r) => { pending.push(r); }));
      const { hook } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.5));
      expect(prefetchWindow).toHaveBeenCalledTimes(1);
      act(() => hook.result.current.show(0.7));
      act(() => hook.result.current.show(0.8));
      expect(prefetchWindow).toHaveBeenCalledTimes(1);
      await act(async () => { pending[0](); await vi.advanceTimersByTimeAsync(0); });
      expect(previews[0].seeks).toEqual([50]);
      await act(async () => { previews[0].completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
      expect(prefetchWindow).toHaveBeenCalledTimes(2);
      expect(vi.mocked(prefetchWindow).mock.calls[1][2]).toBeCloseTo(80, 5);
    });

    it('pre-warms the preview element after the main video loads its metadata, without painting', async (ctx) => {
      story(ctx, 'Ukryty odtwarzacz podglądu przygotowuje się zaraz po otwarciu nagrania (jedno próbne przewinięcie), więc pierwsze najechanie na pasek nie płaci za „rozgrzewkę” przeglądarki. Próbna klatka nigdy nie trafia do dymka.');
      vi.mocked(isScrubCacheActive).mockReturnValue(true);
      const main = Object.assign(new EventTarget(), { duration: 100, currentSrc: URL_T1, src: URL_T1, readyState: 0 });
      const { hook } = setup(main as unknown as HTMLVideoElement);
      expect(previews).toHaveLength(0);
      main.readyState = 1;
      await act(async () => { main.dispatchEvent(new Event('loadedmetadata')); await vi.advanceTimersByTimeAsync(0); });
      expect(previews).toHaveLength(1);
      expect(previews[0].el.getAttribute('src')).toContain('scrub=1');
      expect(previews[0].seeks).toEqual([0]);
      await act(async () => { previews[0].completeSeek(0); await vi.advanceTimersByTimeAsync(0); });
      expect(draws()).toBe(0);
      expect(hook.result.current.state).toBe('hidden');
    });

    it('a spot hovered before shows its frame at once, ready, with no seek', async (ctx) => {
      story(ctx, 'Ponowne najechanie na miejsce, którego klatka była już pokazana, rysuje ją natychmiast z pamięci — bez przewijania ukrytego odtwarzacza.');
      const { hook } = setup();
      act(() => hook.result.current.show(0.3));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      const pv = previews[0];
      await act(async () => { pv.completeSeek(30); await vi.advanceTimersByTimeAsync(0); });
      expect(draws()).toBe(1);
      act(() => hook.result.current.hide());
      act(() => hook.result.current.show(0.3));
      expect(hook.result.current.state).toBe('ready');
      expect(draws()).toBe(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(pv.seeks).toEqual([30]);
    });

    it('a cached frame near the spot is shown at once, then the exact frame', async (ctx) => {
      story(ctx, 'Gdy w pamięci jest klatka z pobliża (do 1 s), dymek od razu ją pokazuje, bez wyszarzania, a po chwili podmienia na dokładną klatkę.');
      const { hook } = setup();
      act(() => hook.result.current.show(0.3));
      const pv = previews[0];
      await act(async () => { pv.completeSeek(30); await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.305));
      expect(hook.result.current.state).toBe('ready');
      expect(draws()).toBe(2); // provisional
      expect(pv.seeks).toEqual([30, 30.5]);
      await act(async () => { pv.completeSeek(30.5); await vi.advanceTimersByTimeAsync(0); });
      expect(hook.result.current.state).toBe('ready');
      expect(draws()).toBe(3);
    });

    it('cached frames are forgotten when the recording changes', async (ctx) => {
      story(ctx, 'Po przełączeniu na inne nagranie podgląd nie pokazuje klatek z poprzedniego.');
      const { hook, main } = setup();
      act(() => hook.result.current.show(0.3));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      await act(async () => { previews[0].completeSeek(30); await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.hide());
      Object.assign(main, { currentSrc: URL_OTHER, src: URL_OTHER });
      hook.rerender({ k: 2 });
      act(() => hook.result.current.show(0.3));
      expect(hook.result.current.state).toBe('loading');
      expect(draws()).toBe(1);
    });

    it('cached frames are forgotten when the scrub cache is wiped (sign-out)', async (ctx) => {
      story(ctx, 'Po wylogowaniu klatki podglądu znikają z pamięci razem z buforem nagrań.');
      let wipe: () => void = () => {};
      vi.mocked(onScrubCacheWipe).mockImplementation((cb) => { wipe = cb; return () => {}; });
      const { hook } = setup();
      act(() => hook.result.current.show(0.3));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      await act(async () => { previews[0].completeSeek(30); await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.hide());
      act(() => wipe());
      act(() => hook.result.current.show(0.3));
      expect(hook.result.current.state).toBe('loading');
      expect(draws()).toBe(1);
    });

    it('shows the keyframe first (dimmed), then the exact frame', async (ctx) => {
      story(ctx, 'Między klatkami kluczowymi podgląd najpierw pokazuje najbliższą wcześniejszą klatkę kluczową (szybką do zdekodowania, przygaszoną), a potem dokładną klatkę.');
      const ix = index(100, [0, 50]);
      vi.mocked(isScrubCacheActive).mockReturnValue(true);
      vi.mocked(loadSampleIndex).mockResolvedValue(ix);
      const { hook } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.6));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      const pv = previews[0];
      expect(pv.seeks).toEqual([50]);
      await act(async () => { pv.completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
      expect(draws()).toBe(1);
      expect(hook.result.current.state).toBe('loading');
      expect(pv.seeks).toEqual([50, 60]);
      await act(async () => { pv.completeSeek(60); await vi.advanceTimersByTimeAsync(0); });
      expect(draws()).toBe(2);
      expect(hook.result.current.state).toBe('ready');
    });

    it('moving far away between the keyframe and the exact frame dims the frame left behind', async (ctx) => {
      story(ctx, 'Jeśli kursor odjedzie daleko, zanim dokładna klatka się wczyta, klatka z poprzedniego miejsca jest przygaszona, dopóki nie wczyta się ta spod kursora.');
      const ix = index(100, [0, 50]);
      vi.mocked(isScrubCacheActive).mockReturnValue(true);
      vi.mocked(loadSampleIndex).mockResolvedValue(ix);
      const { hook } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.6));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      const pv = previews[0];
      await act(async () => { pv.completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.9));
      await act(async () => { pv.completeSeek(60); await vi.advanceTimersByTimeAsync(0); });
      expect(draws()).toBe(2);
      expect(hook.result.current.state).toBe('loading'); // 60 s on screen, pointer at 90 s
      // The run for 90 s follows at once: keyframe first (nothing close on screen), then 90 s.
      expect(pv.seeks).toEqual([50, 60, 50]);
      await act(async () => { pv.completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
      expect(pv.seeks.at(-1)).toBe(90);
      await act(async () => { pv.completeSeek(90); await vi.advanceTimersByTimeAsync(0); });
      expect(hook.result.current.state).toBe('ready');
    });
  
    it('prefetches the run-up after the pointer settles on a cached frame, without holding back the seek', async (ctx) => {
      story(ctx, 'Na skraju szarego odcinka klatka pokazuje się od razu, a gdy kursor się zatrzyma, podgląd dociąga w tle kilka kolejnych sekund — po puszczeniu film rusza bez czekania.');
      const ix = index(100, [0, 50]);
      workerHolds(100_000, [{ start: 0, end: 61_000 }]); // 60 s cached, 61..65 s not
      vi.mocked(loadSampleIndex).mockResolvedValue(ix);
      vi.mocked(prefetchWindow).mockImplementation(() => new Promise<void>(() => {})); // never finishes
      const { hook } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.5));
      await act(async () => { await Promise.resolve(); });
      const pv = previews[0];
      expect(pv.seeks).toEqual([50]);
      await act(async () => { pv.completeSeek(50); await vi.advanceTimersByTimeAsync(0); });
      expect(hook.result.current.state).toBe('ready');
      expect(prefetchWindow).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(prefetchWindow).toHaveBeenCalledTimes(1);
      const [url, gotIx, t, , signal] = vi.mocked(prefetchWindow).mock.calls[0];
      expect(url).toContain('scrub=1');
      expect(gotIx).toBe(ix);
      expect(t).toBeCloseTo(50, 5);
      act(() => hook.result.current.hide());
      expect((signal as AbortSignal).aborted).toBe(true);
    });

    it('does not prefetch the run-up when the pointer moves on before settling', async (ctx) => {
      story(ctx, 'Przy szybkim przesuwaniu po szarym odcinku nic nie jest dociągane z sieci — dopiero zatrzymanie kursora uruchamia pobieranie w tle.');
      const ix = index(100, [0, 50]);
      workerHolds(100_000, [{ start: 0, end: 61_000 }]);
      vi.mocked(loadSampleIndex).mockResolvedValue(ix);
      const { hook } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      act(() => hook.result.current.show(0.5));
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      act(() => hook.result.current.show(0.52));
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      act(() => hook.result.current.hide());
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(prefetchWindow).not.toHaveBeenCalled();
    });

    it('a frame no callback could confirm is never served later as the exact frame', async (ctx) => {
      story(ctx, 'Klatka, której przeglądarka nie potwierdziła, może posłużyć najwyżej jako przygaszone przybliżenie — przy ponownym najechaniu podgląd i tak szuka dokładnej klatki.');
      const { hook } = setup();
      act(() => hook.result.current.show(0.3));
      act(() => hook.result.current.hide());
      const pv = previews[0];
      // An engine without requestVideoFrameCallback: seeks end `unconfirmed`.
      Object.defineProperty(pv.el, 'requestVideoFrameCallback', { configurable: true, value: undefined });
      pv.seeks.length = 0;
      act(() => hook.result.current.show(0.3));
      await act(async () => { pv.completeSeek(30); await vi.advanceTimersByTimeAsync(50); });
      await act(async () => { pv.completeSeek(30); await vi.advanceTimersByTimeAsync(50); });
      expect(hook.result.current.state).toBe('ready');
      expect(pv.seeks).toEqual([30, 30]);
      act(() => hook.result.current.hide());
      act(() => hook.result.current.show(0.3));
      expect(hook.result.current.state).toBe('loading');
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(pv.seeks).toEqual([30, 30, 30]);
    });
  });
});

