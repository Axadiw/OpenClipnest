import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createSettleScheduler, type SettleScheduler } from '../lib/scrubPreview/scheduler';
import { loadSampleIndex, prefetchWindow, sampleIndexTotal } from '../lib/scrubPreview/sampleIndexLoader';
import { usableCachedRanges } from '../lib/scrubPreview/cachedSegments';
import { createFrameCache, snapshotCanvas, type CachedFrame } from '../lib/scrubPreview/frameCache';
import { isScrubCacheActive, onScrubCacheWipe, refreshCachedRanges, subscribeCachedRanges } from '../lib/scrubCache/client';
import { videoCacheKey } from '../sw/videoRequest';
import { covers, type ByteRange } from '../lib/byteRanges';
import { keyframeAtOrBefore, type SampleIndex } from '../lib/mp4/sampleTable';

export type ScrubPreviewState = 'hidden' | 'loading' | 'ready';

export interface ScrubPreview {
  state: ScrubPreviewState;
  /** Seconds into the recording the bubble describes. */
  time: number;
  /** Same position as a 0..1 fraction of the bar. */
  fraction: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  show(fraction: number): void;
  hide(): void;
  sampleIndex: SampleIndex | null;
  /** Byte size of the file `sampleIndex` was parsed from (0 until known). */
  sampleTotal: number;
}

export const PREVIEW_WIDTH_PX = 160;
/** A presented frame within this many seconds of the expected one counts as the right frame. */
const FRAME_TOLERANCE_SEC = 0.05;
/** Without a sample index the expected frame is unknown; it lies at most this far before `t`. */
const NO_INDEX_LOOKBACK_SEC = 1;
/** After `seeked`, how long to wait for the frame callback of this seek. */
const FRAME_GRACE_MS = 300;
/** A seek that has not reported `seeked` by now is retried (first seeks on WebKit can stall). */
const SEEK_TIMEOUT_MS = 3000;
const METADATA_TIMEOUT_MS = 8000;
/** A cached frame this close (seconds) to the pointed-at time is shown as a dimmed stand-in. */
const NEAR_FRAME_SEC = 1;
/** Once the pointer has rested this long, the run-up after the spot is prefetched in the background. */
const RUNUP_SETTLE_MS = 200;
/**
 * The bubble is dimmed only while the frame on screen is further than this (seconds) from the
 * pointed-at time. During a sweep the frame trails the pointer by a run or so; that is shown as
 * live, not greyed out until the pointer stops.
 */
const LIVE_GAP_SEC = 2;

type FrameMeta = { mediaTime: number };
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

type SeekResult =
  | { kind: 'match'; mediaTime: number }
  /** `seeked` fired but no frame callback could confirm the frame. */
  | { kind: 'unconfirmed' }
  | { kind: 'mismatch' }
  | { kind: 'failed' };

/** Preview URL: the main element's current source (fresh token) marked as a preview read. */
function previewSrc(src: string): string {
  try {
    const u = new URL(src, window.location.href);
    u.searchParams.set('scrub', '1');
    return u.origin === window.location.origin ? u.pathname + u.search : u.toString();
  } catch {
    return src + (src.includes('?') ? '&' : '?') + 'scrub=1';
  }
}

/** Index of the sample shown at `t`: the latest one starting at or before it (else the earliest). */
function sampleAt(ix: SampleIndex, t: number): number {
  let best = -1;
  let first = -1;
  for (let i = 0; i < ix.pts.length; i++) {
    const p = ix.pts[i];
    if (first < 0 || p < ix.pts[first]) first = i;
    if (p <= t + 1e-3 && (best < 0 || p > ix.pts[best])) best = i;
  }
  return best < 0 ? first : best;
}

/** Presentation time of the frame shown at `t`: the latest sample starting at or before it. */
function expectedFrameTime(ix: SampleIndex, t: number): number {
  const i = sampleAt(ix, t);
  return i < 0 ? t : ix.pts[i];
}

/** Frame-cache key: the exact frame time with an index, else `t` rounded to 0.1 s. */
function frameKey(ix: SampleIndex | null, t: number): number {
  if (ix && ix.pts.length > 0) return expectedFrameTime(ix, t);
  return Math.round(t * 10) / 10;
}

function frameMatches(ix: SampleIndex | null, t: number, mediaTime: number): boolean {
  if (ix && ix.pts.length > 0) return Math.abs(mediaTime - expectedFrameTime(ix, t)) <= FRAME_TOLERANCE_SEC;
  return mediaTime <= t + FRAME_TOLERANCE_SEC && mediaTime > t - NO_INDEX_LOOKBACK_SEC;
}

/** Resolves true when `type` fires, false on abort or timeout. */
function waitFor(el: EventTarget, type: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      el.removeEventListener(type, onEvent);
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    el.addEventListener(type, onEvent);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * One seek of the preview element, confirmed per seek: the frame callback is registered BEFORE
 * `currentTime` is set, and only a presented frame whose mediaTime matches the target counts.
 * Without `requestVideoFrameCallback` the result is `unconfirmed` after `seeked` + one frame.
 */
function seekOnce(
  pv: FrameCallbackVideo, t: number, matches: (mediaTime: number) => boolean, signal: AbortSignal,
): Promise<SeekResult> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve({ kind: 'failed' }); return; }
    const rvfc = typeof pv.requestVideoFrameCallback === 'function';
    let done = false;
    let seeked = false;
    let lastMediaTime: number | null = null;
    let cbId: number | null = null;
    let rafId: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (r: SeekResult) => {
      if (done) return;
      done = true;
      clearTimeout(seekTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (cbId !== null) pv.cancelVideoFrameCallback?.(cbId);
      if (rafId !== null) cancelAnimationFrame(rafId);
      pv.removeEventListener('seeked', onSeeked);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onFrame = (_now: number, meta: FrameMeta) => {
      cbId = null;
      if (done) return;
      lastMediaTime = meta.mediaTime;
      if (seeked && matches(meta.mediaTime)) { finish({ kind: 'match', mediaTime: meta.mediaTime }); return; }
      cbId = pv.requestVideoFrameCallback!(onFrame); // keep listening for this seek's frame
    };
    const onSeeked = () => {
      if (done) return;
      seeked = true;
      if (!rvfc) {
        rafId = requestAnimationFrame(() => { rafId = null; finish({ kind: 'unconfirmed' }); });
        return;
      }
      if (lastMediaTime !== null && matches(lastMediaTime)) { finish({ kind: 'match', mediaTime: lastMediaTime }); return; }
      graceTimer = setTimeout(() => {
        finish(lastMediaTime === null ? { kind: 'unconfirmed' } : { kind: 'mismatch' });
      }, FRAME_GRACE_MS);
    };
    const onAbort = () => finish({ kind: 'failed' });
    const seekTimer = setTimeout(() => finish({ kind: 'failed' }), SEEK_TIMEOUT_MS);

    signal.addEventListener('abort', onAbort);
    pv.addEventListener('seeked', onSeeked);
    if (rvfc) cbId = pv.requestVideoFrameCallback!(onFrame);
    pv.currentTime = t;
  });
}

/**
 * Hover / drag preview for the seek bar. A hidden `<video>` (sharing the main element's source
 * plus `scrub=1`) is seeked to the pointed-at time and its frame is drawn onto `canvasRef`. The
 * main element is never touched.
 *
 * - With the service worker active, the element is created and warmed up (one seek, never
 *   painted) as soon as the main video has its metadata, so the first hover does not pay for the
 *   engine's unconfirmed first seek. Without the worker it is created on the first `show`.
 * - Runs start as soon as the pointer moves, one at a time; a point that arrives during a run
 *   is taken up right after it (only the latest), so the bubble follows a sweep. Without the
 *   frame's bytes cached, only those bytes are prefetched into the worker first; the run-up
 *   after the spot waits until the pointer rests.
 * - The bubble is dimmed only while the frame on screen is more than `LIVE_GAP_SEC` from the
 *   pointer, so a frame trailing a sweep by a moment reads as live.
 * - Painted frames are kept in memory per recording: an exact hit is drawn at once; a frame
 *   within a second stands in while the exact one loads.
 * - With a sample index and nothing close on screen, the keyframe before the target is shown
 *   first (cheap to decode).
 */
export function useScrubPreview(
  videoRef: RefObject<HTMLVideoElement | null>, mediaKey: unknown,
): ScrubPreview {
  const [state, setState] = useState<ScrubPreviewState>('hidden');
  const [time, setTime] = useState(0);
  const [fraction, setFraction] = useState(0);
  const [sampleIndex, setSampleIndex] = useState<SampleIndex | null>(null);
  const [sampleTotal, setSampleTotal] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stateRef = useRef<ScrubPreviewState>('hidden');
  const timeRef = useRef(0);
  const previewRef = useRef<FrameCallbackVideo | null>(null);
  const srcRef = useRef('');
  const recordingRef = useRef<string | null>(null);
  /** False until a frame of the current preview source was confirmed (first seeks can be stale). */
  const confirmedRef = useRef(false);
  const ixRef = useRef<SampleIndex | null>(null);
  const cachedRef = useRef<{ total: number; ranges: ByteRange[] }>({ total: 0, ranges: [] });
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const indexCtrlRef = useRef<AbortController | null>(null);
  const schedulerRef = useRef<SettleScheduler | null>(null);
  const indexForRef = useRef<string | null>(null);
  const [frames] = useState(createFrameCache);
  /** Bumped whenever the frame cache is cleared, so a snapshot finishing late is dropped. */
  const framesGenRef = useRef(0);
  /** A frame to draw once the bubble's canvas is mounted (it is not while the bubble is hidden). */
  const pendingDrawRef = useRef<CachedFrame | null>(null);
  /** The time a near cached frame was shown for (its run skips the keyframe step). */
  const nearShownForRef = useRef<number | null>(null);
  const warmCtrlRef = useRef<AbortController | null>(null);
  const runupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runupCtrlRef = useRef<AbortController | null>(null);
  const warmedForRef = useRef<string | null>(null);
  /** Media time of the frame on the bubble's canvas (null: nothing drawn for this hover yet). */
  const shownRef = useRef<number | null>(null);

  const setPreviewState = useCallback((s: ScrubPreviewState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** Cancels a pending or running run-up prefetch (pointer moved, bubble hidden, teardown). */
  const cancelRunup = useCallback(() => {
    if (runupTimerRef.current !== null) { clearTimeout(runupTimerRef.current); runupTimerRef.current = null; }
    runupCtrlRef.current?.abort();
    runupCtrlRef.current = null;
  }, []);

  const clearFrames = useCallback(() => {
    frames.clear();
    framesGenRef.current++;
    pendingDrawRef.current = null;
    nearShownForRef.current = null;
  }, [frames]);

  const drawFrame = useCallback((f: CachedFrame) => {
    shownRef.current = f.mediaTime;
    const canvas = canvasRef.current;
    if (!canvas) { pendingDrawRef.current = f; return; }
    pendingDrawRef.current = null;
    if (canvas.width !== f.width) canvas.width = f.width;
    if (canvas.height !== f.height) canvas.height = f.height;
    canvas.getContext('2d')?.drawImage(f.image, 0, 0, f.width, f.height);
  }, []);

  /** 'ready' when the frame on screen is close enough to the pointer to read as live. */
  const liveState = useCallback((): ScrubPreviewState => {
    const shown = shownRef.current;
    return shown !== null && Number.isFinite(shown) && Math.abs(shown - timeRef.current) <= LIVE_GAP_SEC
      ? 'ready' : 'loading';
  }, []);

  // The bubble mounts its canvas on the render after `show`: draw what `show` could not.
  useLayoutEffect(() => {
    const f = pendingDrawRef.current;
    if (f && canvasRef.current) drawFrame(f);
  });

  /** Draws the preview element's current frame and keeps a copy under `key`. */
  const paint = useCallback((pv: HTMLVideoElement, key: number, mediaTime: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !pv.videoWidth || !pv.videoHeight) return;
    pendingDrawRef.current = null;
    const h = Math.max(1, Math.round((PREVIEW_WIDTH_PX * pv.videoHeight) / pv.videoWidth));
    if (canvas.width !== PREVIEW_WIDTH_PX) canvas.width = PREVIEW_WIDTH_PX;
    if (canvas.height !== h) canvas.height = h;
    canvas.getContext('2d')?.drawImage(pv, 0, 0, PREVIEW_WIDTH_PX, h);
    shownRef.current = Number.isFinite(mediaTime) ? mediaTime : pv.currentTime;
    const gen = framesGenRef.current;
    void snapshotCanvas(canvas, mediaTime).then((f) => {
      if (!f) return;
      if (gen === framesGenRef.current) frames.put(key, f);
      else (f.image as { close?: () => void }).close?.();
    });
  }, [frames]);

  /** True when the worker holds every byte from the keyframe before `t` to the frame at `t`. */
  const frameBytesCached = useCallback((t: number): boolean => {
    const ix = ixRef.current;
    if (!ix || ix.keyframes.length === 0 || ix.pts.length === 0 || !isScrubCacheActive()) return false;
    const s = sampleAt(ix, t);
    const k = keyframeAtOrBefore(ix, t);
    const start = Math.min(ix.offset[k], ix.offset[s]);
    const end = Math.max(ix.offset[k] + ix.size[k], ix.offset[s] + ix.size[s]);
    const { total, ranges } = cachedRef.current;
    return covers(usableCachedRanges(ranges, total, sampleIndexTotal(srcRef.current)), { start, end });
  }, []);

  const run = useCallback(async (t: number, signal: AbortSignal) => {
    const pv = previewRef.current;
    if (!pv) return;
    warmCtrlRef.current?.abort(); // a real hover takes over the element
    const ix = ixRef.current;
    if (ix && isScrubCacheActive() && !frameBytesCached(t)) {
      // Only the bytes this frame needs: the run-up after it waits until the pointer rests.
      try { await prefetchWindow(srcRef.current, ix, t, cachedRef.current.ranges, signal, 0); } catch { /* the seek still loads it */ }
    }
    if (signal.aborted) return;
    if (pv.readyState < 1 && !(await waitFor(pv, 'loadedmetadata', signal, METADATA_TIMEOUT_MS))) return;
    if (signal.aborted) return;
    const target = Number.isFinite(pv.duration) && pv.duration > 0 ? Math.min(Math.max(0, t), pv.duration - 0.001) : t;
    const matches = (mt: number) => frameMatches(ixRef.current, target, mt);

    // Keyframe first: cheapest to decode, shown dimmed while the exact frame is decoded.
    if (ix && ix.keyframes.length > 0 && nearShownForRef.current !== t && liveState() !== 'ready') {
      const kfTime = ix.pts[keyframeAtOrBefore(ix, target)];
      if (Math.abs(kfTime - expectedFrameTime(ix, target)) > FRAME_TOLERANCE_SEC) {
        const kr = await seekOnce(pv, kfTime, (mt) => frameMatches(ix, kfTime, mt), signal);
        if (signal.aborted) return;
        if (kr.kind === 'match') {
          confirmedRef.current = true;
          paint(pv, frameKey(ix, kfTime), kr.mediaTime);
          if (stateRef.current !== 'hidden') setPreviewState(liveState());
        }
      }
    }

    let r = await seekOnce(pv, target, matches, signal);
    if (signal.aborted) return;
    // A mismatch, a stall, or a frame no callback could confirm on a fresh element: retry once.
    const retry = r.kind === 'mismatch' || r.kind === 'failed' || (r.kind === 'unconfirmed' && !confirmedRef.current);
    if (retry) {
      const second = await seekOnce(pv, target, matches, signal);
      if (signal.aborted) return;
      // An unconfirmed second attempt is accepted: it is the warm-up path for engines without rVFC.
      r = second;
    }
    if (r.kind !== 'match' && r.kind !== 'unconfirmed') return;
    if (signal.aborted) return;
    confirmedRef.current = true;
    // An unconfirmed frame is cached with an unknown time: it can stand in as a near hit but
    // never passes the exact-hit check.
    paint(pv, frameKey(ixRef.current, target), r.kind === 'match' ? r.mediaTime : NaN);
    // A run can finish after the pointer moved on: its frame then stands in until the next one.
    if (stateRef.current !== 'hidden') setPreviewState(liveState());
  }, [paint, setPreviewState, frameBytesCached, liveState]);

  const teardown = useCallback(() => {
    cancelRunup();
    schedulerRef.current?.dispose();
    schedulerRef.current = null;
    indexCtrlRef.current?.abort();
    indexCtrlRef.current = null;
    warmCtrlRef.current?.abort();
    warmCtrlRef.current = null;
    warmedForRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const pv = previewRef.current;
    if (pv) {
      pv.removeAttribute('src');
      try { pv.load(); } catch { /* ignore */ }
      pv.remove();
    }
    previewRef.current = null;
    srcRef.current = '';
    recordingRef.current = null;
    confirmedRef.current = false;
    ixRef.current = null;
    indexForRef.current = null;
    cachedRef.current = { total: 0, ranges: [] };
    clearFrames();
    setSampleIndex(null);
    setSampleTotal(0);
  }, [clearFrames, cancelRunup]);

  const hide = useCallback(() => {
    cancelRunup();
    schedulerRef.current?.leave();
    nearShownForRef.current = null;
    pendingDrawRef.current = null;
    shownRef.current = null;
    if (stateRef.current !== 'hidden') setPreviewState('hidden');
  }, [setPreviewState, cancelRunup]);

  /** Loads the sample index of the recording behind `src` once (memoised per key by the loader). */
  const ensureIndex = useCallback((src: string) => {
    const key = videoCacheKey(src) ?? src.split('?')[0];
    if (indexForRef.current === key) return;
    indexForRef.current = key;
    ixRef.current = null;
    setSampleIndex(null);
    setSampleTotal(0);
    indexCtrlRef.current?.abort();
    const ctrl = new AbortController();
    indexCtrlRef.current = ctrl;
    void loadSampleIndex(src, ctrl.signal).then((ix) => {
      if (ctrl.signal.aborted || !ix) return;
      ixRef.current = ix;
      setSampleTotal(sampleIndexTotal(src));
      setSampleIndex(ix);
    });
  }, []);

  /** Makes sure the preview element exists and points at the main element's current source. */
  const attach = useCallback((v: HTMLVideoElement): boolean => {
    const mainSrc = v.currentSrc || v.src;
    if (!mainSrc) return false;
    const recording = videoCacheKey(mainSrc) ?? mainSrc.split('?')[0];
    if (recordingRef.current !== null && recordingRef.current !== recording) teardown();
    const src = previewSrc(mainSrc);
    let pv = previewRef.current;
    if (!pv) {
      pv = document.createElement('video') as FrameCallbackVideo;
      pv.muted = true;
      pv.playsInline = true;
      pv.preload = 'metadata';
      pv.setAttribute('aria-hidden', 'true');
      pv.setAttribute('data-testid', 'player-seek-preview-video');
      pv.style.display = 'none';
      document.body.appendChild(pv);
      previewRef.current = pv;
    }
    if (srcRef.current !== src) {
      srcRef.current = src;
      confirmedRef.current = false;
      pv.setAttribute('src', src);
    }
    if (recordingRef.current !== recording) {
      recordingRef.current = recording;
      if (isScrubCacheActive()) {
        unsubscribeRef.current = subscribeCachedRanges(src, (r) => { cachedRef.current = r; });
        ensureIndex(src);
      }
    }
    return true;
  }, [teardown, ensureIndex]);

  /**
   * Creates the preview element ahead of the first hover and seeks it once (to the first
   * keyframe), so the engine's unconfirmed first seek is paid before anyone waits on it. Only with
   * the worker active: the head and first GOP it reads are then already cached by the player.
   */
  const warmUp = useCallback(() => {
    const v = videoRef.current;
    if (!v || !isScrubCacheActive() || !(v.readyState >= 1)) return;
    if (!attach(v)) return;
    const pv = previewRef.current;
    const recording = recordingRef.current;
    if (!pv || !recording || warmedForRef.current === recording) return;
    warmedForRef.current = recording;
    const ctrl = new AbortController();
    warmCtrlRef.current = ctrl;
    void (async () => {
      if (pv.readyState < 1 && !(await waitFor(pv, 'loadedmetadata', ctrl.signal, METADATA_TIMEOUT_MS))) return;
      if (ctrl.signal.aborted) return;
      const ix = ixRef.current;
      const t0 = ix && ix.keyframes.length > 0 ? ix.pts[ix.keyframes[0]] : 0;
      const r = await seekOnce(pv, t0, (mt) => frameMatches(ix, t0, mt), ctrl.signal);
      if (!ctrl.signal.aborted && r.kind === 'match') confirmedRef.current = true;
    })().finally(() => {
      if (warmCtrlRef.current === ctrl) warmCtrlRef.current = null;
    });
  }, [videoRef, attach]);

  /**
   * A frame shown without a network run (cached bytes or a cached frame) does not wait for the
   * network, but releasing there should still play straight from the cache: once the pointer
   * rests, the run-up is fetched in the background. `prefetchWindow` skips what is cached, so
   * this is free when the run-up is already there. Moving on before it fires cancels it.
   */
  const scheduleRunup = useCallback((t: number) => {
    const ix = ixRef.current;
    if (!ix || !isScrubCacheActive()) return;
    if (runupTimerRef.current !== null || runupCtrlRef.current !== null) return; // same time, already on it
    const src = srcRef.current;
    const fire = () => {
      // One preview fetch at a time: the run for this spot goes first.
      if (schedulerRef.current?.inFlight()) { runupTimerRef.current = setTimeout(fire, RUNUP_SETTLE_MS); return; }
      runupTimerRef.current = null;
      const ctrl = new AbortController();
      runupCtrlRef.current = ctrl;
      void prefetchWindow(src, ix, t, cachedRef.current.ranges, ctrl.signal)
        .catch(() => { /* playback fetches it instead */ })
        .finally(() => { if (runupCtrlRef.current === ctrl) runupCtrlRef.current = null; });
    };
    runupTimerRef.current = setTimeout(fire, RUNUP_SETTLE_MS);
  }, []);

  const show = useCallback((f: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    // Opening the bubble: confirm what the worker still holds (it may have restarted and lost
    // it), so a stretch that is no longer cached is not treated as instant. A subscription
    // created by `attach` below asks on its own.
    if (stateRef.current === 'hidden') refreshCachedRanges();
    if (!attach(v)) return;
    const frac = Math.min(1, Math.max(0, f));
    const t = frac * v.duration;
    setFraction(frac);
    setTime(t);
    const moved = t !== timeRef.current;
    timeRef.current = t;
    if (moved) cancelRunup();
    if (!schedulerRef.current) schedulerRef.current = createSettleScheduler({ run });
    const ix = ixRef.current;

    // Painted before: the exact frame is drawn at once, nothing to fetch or seek.
    const hit = frames.get(frameKey(ix, t));
    if (hit && frameMatches(ix, t, hit.mediaTime)) {
      schedulerRef.current.leave();
      nearShownForRef.current = null;
      drawFrame(hit);
      setPreviewState('ready');
      scheduleRunup(t);
      return;
    }
    // A frame close by stands in while the exact one loads.
    const near = frames.nearest(t, NEAR_FRAME_SEC);
    nearShownForRef.current = near ? t : null;
    if (near) drawFrame(near);
    setPreviewState(liveState());
    schedulerRef.current.point(t);
    scheduleRunup(t);
  }, [videoRef, attach, run, setPreviewState, drawFrame, frames, scheduleRunup, cancelRunup, liveState]);

  // A new element or source on the main player: stop any preview in flight, and drop the
  // preview element when it now shows another recording (the Timeline remounts its <video> on
  // every seek with the same recording, which keeps the preview).
  useEffect(() => {
    hide();
    const v = videoRef.current;
    const mainSrc = v ? v.currentSrc || v.src : '';
    if (mainSrc && recordingRef.current !== null) {
      const recording = videoCacheKey(mainSrc) ?? mainSrc.split('?')[0];
      if (recording !== recordingRef.current) teardown();
    }
    // With a worker the index is needed before any hover: the seek bar maps the worker's cached
    // bytes to time with it. The source may arrive after mount, hence the events.
    if (!v) return;
    const load = () => {
      const src = v.currentSrc || v.src;
      if (src && isScrubCacheActive()) ensureIndex(src);
    };
    const onMetadata = () => { load(); warmUp(); };
    load();
    warmUp();
    v.addEventListener('loadstart', load);
    v.addEventListener('loadedmetadata', onMetadata);
    return () => {
      v.removeEventListener('loadstart', load);
      v.removeEventListener('loadedmetadata', onMetadata);
    };
  }, [videoRef, mediaKey, hide, teardown, ensureIndex, warmUp]);

  // Painted frames share the scrub cache's lifetime: a sign-out wipes both.
  useEffect(() => onScrubCacheWipe(clearFrames), [clearFrames]);

  useEffect(() => () => teardown(), [teardown]);

  return { state, time, fraction, canvasRef, show, hide, sampleIndex, sampleTotal };
}
