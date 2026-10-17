import { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';

// Default backoff schedule (gap from previous attempt, in seconds).
// Total span: 10+30+60+90+120+150+180+210+240+270 = 1360 s ≈ 22 min — a long
// trickle that gives a flaky uplink room to recover without wedging the
// player on an indefinite spinner. Kept as a module-level constant so a
// referential-equality check on `opts.schedule` (or its absence) doesn't
// thrash effects below.
const DEFAULT_SCHEDULE: number[] = [10, 30, 60, 90, 120, 150, 180, 210, 240, 270];
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_STALL_WINDOW_SEC = 30;
const DEFAULT_CACHE_BUSTER_PARAM = 'retry';
const STALL_TICK_MS = 5_000;

export interface StallRetryOptions {
  /** Optional override for the backoff schedule (gap from previous attempt, seconds). Default per plan. */
  schedule?: number[];
  /** Max attempts. Default 10. */
  maxAttempts?: number;
  /** Stall window — if `video.currentTime` and `video.buffered.end(...)` haven't progressed for this many seconds while in `loadstart`/`waiting`, fire a retry. Default 30. */
  stallWindowSec?: number;
  /** Cache-buster query param name. Default 'retry'. */
  cacheBusterParam?: string;
}

export interface StallRetryState {
  retrying: boolean;
  retryCount: number;
  totalAttempts: number;
  failed: boolean;
  manualRetry: () => void;
  cancel: () => void;
}

/**
 * Auto-retries the source on a `<video>` element when the network stalls or
 * the browser reports a network/decode error during the INITIAL load. Once
 * the player has fired `playing`, the hook stops monitoring — we trust the
 * native chrome's buffering UI for mid-playback hiccups (same rationale as
 * the existing `videoBuffering` flag in VideoPlayer/TimelineView).
 *
 * Retry mechanics:
 *   • On `error` events with code MEDIA_ERR_NETWORK (2) or MEDIA_ERR_DECODE
 *     (3) we schedule a retry per the backoff schedule.
 *   • Every 5 s we sample `currentTime` and the latest `buffered.end()`. If
 *     neither has progressed AND the player is still in initial-load AND
 *     stallWindowSec has elapsed since the last forward progress, we
 *     schedule a retry as if the browser had fired an error.
 *   • Retries reset `video.src` to `''` then to `baseUrl` with a unique
 *     cache-buster query param so intermediaries (and the browser cache)
 *     don't replay a poisoned response.
 *   • After `maxAttempts` retries we stop and expose `failed = true`. The
 *     `manualRetry()` callback resets the counter and kicks off a fresh
 *     attempt; `cancel()` tears down listeners + timers but leaves the
 *     `<video>` source untouched — the caller is responsible for unmounting
 *     or hiding the player.
 *
 * The hook does NOT touch `video.currentTime` — VideoPlayer.tsx already has
 * a `pendingSeekRef`-based central restore effect that re-applies the seek
 * once the new src parses metadata.
 */
export function useVideoStallRetry(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  baseUrl: string | null,
  opts?: StallRetryOptions,
): StallRetryState {
  const schedule = opts?.schedule ?? DEFAULT_SCHEDULE;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stallWindowSec = opts?.stallWindowSec ?? DEFAULT_STALL_WINDOW_SEC;
  const cacheBusterParam = opts?.cacheBusterParam ?? DEFAULT_CACHE_BUSTER_PARAM;

  const [retrying, setRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [failed, setFailed] = useState(false);

  // Tracks the cumulative number of retry attempts triggered for this
  // component instance. Diverges from `retryCount` only after a manualRetry
  // resets the per-cycle counter — useful for breadcrumbs/telemetry.
  const totalAttemptsRef = useRef(0);
  const [totalAttempts, setTotalAttempts] = useState(0);

  // Mutable refs we read/write from event handlers. State alone wouldn't
  // work because handlers are bound once per effect run and need fresh
  // values without re-binding.
  const retryCountRef = useRef(0);
  const failedRef = useRef(false);
  const playingSeenRef = useRef(false);
  // Initialised lazily inside the first effect tick — `Date.now()` at render
  // time is impure and trips the react-hooks/components-and-hooks-must-be-pure
  // rule.
  const lastProgressTsRef = useRef<number>(0);
  const lastCurrentTimeRef = useRef(0);
  const lastBufferedEndRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (stallTimerRef.current !== null) {
      clearInterval(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const performRetry = useCallback((errCode: number | null) => {
    if (cancelledRef.current) return;
    if (failedRef.current) return;
    if (!baseUrl) return;
    const v = videoRef.current;
    if (!v) return;

    const attempt = retryCountRef.current + 1;
    if (attempt > maxAttempts) {
      failedRef.current = true;
      setFailed(true);
      setRetrying(false);
      return;
    }

    retryCountRef.current = attempt;
    setRetryCount(attempt);
    totalAttemptsRef.current += 1;
    setTotalAttempts(totalAttemptsRef.current);
    setRetrying(true);

    Sentry.addBreadcrumb({
      category: 'video',
      message: 'stall-retry',
      data: { src: baseUrl, attempt, code: errCode },
    });

    // Reset src to force the browser to drop any in-flight network state,
    // then re-bind with a unique cache-buster so any cached/poisoned bytes
    // are bypassed. Setting src to '' before re-assignment is the standard
    // way to fully tear down a media pipeline (HTMLMediaElement spec
    // §load()).
    const sep = baseUrl.includes('?') ? '&' : '?';
    const newUrl = `${baseUrl}${sep}${cacheBusterParam}=${attempt}`;
    try {
      v.src = '';
      v.src = newUrl;
      // load() makes the browser commit to the new src immediately rather
      // than waiting for the next interaction.
      v.load();
    } catch {
      // Ignore — if src assignment throws we'll retry next cycle.
    }

    // Reset progress markers so the stall watcher doesn't immediately
    // re-trigger on the freshly-loading source.
    lastProgressTsRef.current = Date.now();
    lastCurrentTimeRef.current = 0;
    lastBufferedEndRef.current = 0;
  }, [baseUrl, cacheBusterParam, maxAttempts, videoRef]);

  const scheduleRetry = useCallback((errCode: number | null) => {
    if (cancelledRef.current) return;
    if (failedRef.current) return;
    const nextAttemptIndex = retryCountRef.current; // 0-based: 0 → first delay
    if (nextAttemptIndex >= maxAttempts) {
      failedRef.current = true;
      setFailed(true);
      setRetrying(false);
      return;
    }
    const gapSec = schedule[Math.min(nextAttemptIndex, schedule.length - 1)] ?? schedule[schedule.length - 1] ?? 30;
    setRetrying(true);
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      performRetry(errCode);
    }, gapSec * 1000);
  }, [maxAttempts, performRetry, schedule]);

  const manualRetry = useCallback(() => {
    // Operator-invoked reset: zero out the cycle counter, drop the failed
    // flag, and immediately attempt a fresh load (no backoff). Matches the
    // typical "Retry" button UX where waiting another 4.5 minutes after the
    // user explicitly asked would feel broken.
    cancelledRef.current = false;
    clearTimers();
    retryCountRef.current = 0;
    failedRef.current = false;
    setRetryCount(0);
    setFailed(false);
    setRetrying(false);
    // performRetry increments retryCountRef back to 1; that's intentional —
    // a manualRetry counts as attempt #1 of a fresh cycle.
    performRetry(null);
  }, [clearTimers, performRetry]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimers();
    setRetrying(false);
  }, [clearTimers]);

  // Reset all state when the baseUrl changes (new event / new view).
  useEffect(() => {
    cancelledRef.current = false;
    failedRef.current = false;
    retryCountRef.current = 0;
    playingSeenRef.current = false;
    lastProgressTsRef.current = Date.now();
    lastCurrentTimeRef.current = 0;
    lastBufferedEndRef.current = 0;
    setRetryCount(0);
    setRetrying(false);
    setFailed(false);
    return () => {
      clearTimers();
    };
  }, [baseUrl, clearTimers]);

  // Bind <video> listeners + start the stall watcher. Re-binds when the
  // baseUrl changes so the closures see the right URL. We intentionally do
  // NOT depend on videoRef.current — refs aren't reactive — but the hook
  // re-runs every render of the parent (cheap) which is fine; setting up
  // listeners on the same element is idempotent because we add and remove
  // them within the same effect.
  useEffect(() => {
    if (!baseUrl) return;
    const v = videoRef.current;
    if (!v) return;

    const onError = () => {
      const err = v.error;
      if (!err) return;
      // MediaError.code: 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
      // We retry only on NETWORK + DECODE — ABORTED is usually our own teardown
      // and SRC_NOT_SUPPORTED is deterministic (codec mismatch, no point retrying).
      if (err.code !== 2 && err.code !== 3) return;
      scheduleRetry(err.code);
    };

    const onPlaying = () => {
      // Initial load complete. Stop the stall watcher — mid-playback stalls
      // are owned by the browser's native chrome.
      playingSeenRef.current = true;
    };

    const onProgress = () => {
      const ct = Number.isFinite(v.currentTime) ? v.currentTime : 0;
      const bufEnd = v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0;
      if (ct !== lastCurrentTimeRef.current || bufEnd !== lastBufferedEndRef.current) {
        lastCurrentTimeRef.current = ct;
        lastBufferedEndRef.current = bufEnd;
        lastProgressTsRef.current = Date.now();
      }
    };

    v.addEventListener('error', onError);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('progress', onProgress);
    v.addEventListener('timeupdate', onProgress);

    // Stall watcher — runs only during initial load (playingSeenRef false).
    if (stallTimerRef.current !== null) {
      clearInterval(stallTimerRef.current);
    }
    stallTimerRef.current = setInterval(() => {
      if (cancelledRef.current) return;
      if (failedRef.current) return;
      if (playingSeenRef.current) return;
      // Don't re-fire while a retry is already armed.
      if (retryTimerRef.current !== null) return;
      const stalledForMs = Date.now() - lastProgressTsRef.current;
      if (stalledForMs >= stallWindowSec * 1000) {
        // Treat as a soft network stall (no explicit error code).
        scheduleRetry(null);
      }
    }, STALL_TICK_MS);

    return () => {
      v.removeEventListener('error', onError);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('timeupdate', onProgress);
      if (stallTimerRef.current !== null) {
        clearInterval(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
  }, [baseUrl, scheduleRetry, stallWindowSec, videoRef]);

  return {
    retrying,
    retryCount,
    totalAttempts,
    failed,
    manualRetry,
    cancel,
  };
}
