import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { enUS, pl, de, fr, it, es, nb } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import { api, ApiError } from '../api';
import { useTranslation } from '../i18n';
import { useTimelineEvents, getDatesInRange, shouldAutoRefresh } from '../hooks/useTimelineEvents';
import { getFilename } from '../types';
import { TimelineDatePicker } from './TimelineDatePicker';
import { CameraChecklist } from './CameraChecklist';
import { ViewIcon } from './ViewIcon';
import { AuthImage } from './AuthImage';
import { BlurredThumbnailBackdrop } from './BlurredThumbnailBackdrop';
import { VideoControls } from './VideoControls';
import { VideoZoom } from './VideoZoom';
import { formatEventDateTime, formatEventTime, nowWallClock, wallClockDayStr } from '../utils/format';
import { useAccountTimezone } from '../hooks/useAccountTimezone';
import { useVideoStallRetry } from '../hooks/useVideoStallRetry';
import { usePlaybackBeacon } from '../hooks/usePlaybackBeacon';
import { useScrubCacheLifetime } from '../hooks/useScrubCacheLifetime';
import { paletteForCameras } from '../lib/cameraColors';
import { parseTimelineUrlParams, serializeInlineVideoToParams, clampSeekToDuration } from './timelineUrlState';
import { dayViewForTimestamp, dayViewForDateStr } from './timelineDayView';
import { computeBufferOverlay } from '../lib/bufferOverlayMath';
import { canStep, stepOnGrid } from '../lib/frameStep';
import { barClickSeekSec, isSameClipSeek, isMacPlatform, LONG_PRESS_MS, PRECISION_FLASH_MS } from './timelineSeek';
import type { CameraEvent, ViewId } from '../types';

interface Props {
  cameraFilter: string[];
  onPlay: (event: CameraEvent, view: ViewId, events?: CameraEvent[]) => void;
  /** Full list of the user's cameras (from `api.getCameras`). Drives the
   *  colour palette so per-camera hues stay stable when zooming changes
   *  which cameras have visible bars. Without it, the palette would be
   *  computed over the visible-only set and zoom-out + zoom-in would
   *  reshuffle hues every time a camera dropped in/out of the window. */
  allCameras: string[];
}

function fmtMB(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 28;
const MIN_BAR_WIDTH = 6;
const EVENT_DURATION_MS = 30_000;
const MIN_VIEW_MS = 2 * 60_000;        // 2 min
const MAX_VIEW_MS = 7 * 24 * 3600_000; // 7 days
const ZOOM_FACTOR = 1.4;
const DRAG_THRESHOLD = 5;
const TOUCH_DRAG_THRESHOLD = 15;
const FETCH_DEBOUNCE_MS = 200;
const AUTO_REFRESH_MS = 60_000;         // silent background poll for new/deleted clips
const AUTO_REFRESH_IDLE_MS = 2_000;     // quiet period after a pan/zoom before a poll may swap data
const CULL_MARGIN = 50;                 // px buffer for edge culling
const HOVER_QUANTIZE_MS = 5_000;        // quantize hover time to 5s for perf

// User-resizable split between the inline player and the timeline. The timeline
// gets an explicit height (draggable via .timeline-splitter); the player flexes
// to fill the rest — so dragging the timeline shorter enlarges the player.
const TIMELINE_HEIGHT_KEY = 'clipnest.timelineHeight';
const MIN_TIMELINE_H = 140;             // nav + ruler + a couple of rows
const MAX_TIMELINE_H_FRAC = 0.72;       // never starve the player below ~28%
const DEFAULT_TIMELINE_H = 300;

// Per-camera visibility filter (visual hide — does NOT change what's fetched,
// unlike the grid's ?cameras= include-filter). Persisted so a power user's
// "only show these 6 of 40" choice survives reloads.
const HIDDEN_CAMS_KEY = 'clipnest.timelineHiddenCameras';

/** Format a Date as YYYY-MM-DD using LOCAL timezone (not UTC). For Dates that
 *  ARE local calendar days — what the date picker hands back. */
function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Format a Date as YYYY-MM-DD using UTC getters. For instants on the timeline's
 *  wall-clock axis — `viewStart` / `viewEnd` are UTC-midnight aligned, so local
 *  getters name the *previous* day for any browser west of Greenwich. */
function toUtcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ⌘ on Mac, Ctrl elsewhere — names the precision-mode modifier in the hint. */
function detectIsMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return isMacPlatform(uaData?.platform || navigator.platform);
}

/** Mouse / trackpad present — only there does a "⌘/Ctrl+click" hint make sense. */
function hasFinePointer(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: fine)').matches;
}

const TICK_LEVELS: { interval: number; showDate: boolean }[] = [
  { interval: 24 * 3600000, showDate: true },
  { interval: 12 * 3600000, showDate: true },
  { interval: 6 * 3600000, showDate: true },
  { interval: 2 * 3600000, showDate: false },
  { interval: 3600000, showDate: false },
  { interval: 1800000, showDate: false },
  { interval: 900000, showDate: false },
  { interval: 300000, showDate: false },
  { interval: 60000, showDate: false },
  { interval: 30000, showDate: false },
];
const MIN_TICK_SPACING_PX = 50;

function getTickInterval(durationMs: number, widthPx: number): { interval: number; showDate: boolean } {
  // Pick the smallest interval that keeps labels at least MIN_TICK_SPACING_PX apart.
  // Iterate from smallest to largest so we maximize detail while respecting label spacing.
  // This also ensures short views get an interval that actually fits within them.
  for (let i = TICK_LEVELS.length - 1; i >= 0; i--) {
    const level = TICK_LEVELS[i];
    const tickCount = durationMs / level.interval;
    const spacing = widthPx / Math.max(tickCount, 1);
    if (spacing >= MIN_TICK_SPACING_PX) {
      return level;
    }
  }
  return TICK_LEVELS[0];
}

export function TimelineView({ cameraFilter, onPlay: _onPlay, allCameras }: Props) {
  const { t, language } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const localeMap: Record<string, Locale> = { pl, de, fr, it, es, no: nb };
  const locale = localeMap[language] || enUS;

  const { eventsByDate, loading, ensureDatesFetched, refreshVisible } = useTimelineEvents(cameraFilter);

  // The zone the cameras' wall clock belongs to. Everything below that has to
  // land on the SAME axis as the event bars — the now-line, the day the view
  // opens on — goes through it. See utils/format `nowWallClock`.
  const accountTz = useAccountTimezone();

  // --- View state ---
  const hadDateParam = useRef(new URLSearchParams(window.location.search).has('date'));
  // URL state for the currently-playing video (`?event=&view=&t=`).
  // Captured once at mount so the hydration effect can decide whether to skip
  // the "auto-play latest event" fallback. `initialHydrationDone` flips true
  // once hydration finishes (or immediately when there is nothing to hydrate),
  // gating the write effect so we don't briefly clear the URL between mount
  // and the async getEvent() resolution.
  // Parse the URL once at mount (lazy init runs only on the first render), then
  // seed the three refs below from the same snapshot without reading a ref's
  // `.current` during render.
  const [initialEventParamsSnapshot] = useState(() =>
    parseTimelineUrlParams(new URLSearchParams(window.location.search)),
  );
  const initialEventParams = useRef(initialEventParamsSnapshot);
  const hadEventParam = useRef(initialEventParamsSnapshot !== null);
  const initialHydrationDone = useRef(initialEventParamsSnapshot === null);
  // Default day is "today on the ACCOUNT clock", not on the browser's — that's
  // the day the cameras are stamping right now, so it's the day that actually
  // holds fresh clips. `accountTz` is seeded synchronously from the cached
  // value (see useAccountTimezone), so this stays a one-shot initializer and
  // the view never re-frames under the user; on the first-ever visit it falls
  // back to the device zone, which is the old behaviour.
  const [viewStart, setViewStart] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const dateStr = params.get('date') || wallClockDayStr(Date.now(), accountTz);
    return dayViewForDateStr(dateStr).viewStart;
  });
  const [viewEnd, setViewEnd] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const dateStr = params.get('date') || wallClockDayStr(Date.now(), accountTz);
    return dayViewForDateStr(dateStr).viewEnd;
  });
  const [inlineVideo, setInlineVideo] = useState<{ event: CameraEvent; view: ViewId; seekSec?: number } | null>(null);
  const [inlineVideoSrc, setInlineVideoSrc] = useState<string | null>(null);
  // The media-token request was refused because the account is locked.
  const [inlineLocked, setInlineLocked] = useState(false);
  const [inlineFrameGrid, setInlineFrameGrid] = useState<number[]>([]);
  // Player "hamburger" menu open state. Declared here (alongside the other
  // inline-player state) so `handleInlinePlay` below can close it without
  // referencing a not-yet-declared setter.
  const [playerMenuOpen, setPlayerMenuOpen] = useState(false);
  const inlineVideoRef = useRef<HTMLVideoElement>(null);
  const inlineWrapRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [cursorGrabbing, setCursorGrabbing] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  // Which camera row the cursor is currently over. Combined with hoverTime
  // it narrows the preview tooltip to "events at this exact moment on
  // this exact camera" instead of the legacy "every camera that has an
  // event in the time window" behaviour. null when the cursor is in the
  // header band (no row).
  const [hoverCamera, setHoverCamera] = useState<string | null>(null);
  // Tracks whether a deferred seek is still armed (waiting for the perceived
  // duration to grow). Drives the buffer overlay on the player + a small
  // pulsing dot on the playhead so the user knows "I'm working on it" instead
  // of staring at a player that looks like it ignored their click.
  const [seekPending, setSeekPending] = useState(false);
  // <video>'s `waiting` event fires while the browser stalls on a buffer
  // gap (typical right after a seek). Combined with seekPending, this drives
  // the same buffer overlay so the indicator covers the whole "click → start
  // playing at the right offset" path, not just the seek-resolution part.
  const [videoBuffering, setVideoBuffering] = useState(false);
  // Sum of `v.buffered` ranges in seconds, not `end(last)`. The "end of
  // last range" heuristic that lived here pre-v0.10.224 reported 100 %
  // any time the player buffered a range touching the clip end (typical
  // seek pattern: a chunk near the start + the chunk containing the seek
  // target, large gap in the middle) — visually nonsensical
  // "100 % · 7.2 MB / 1.7 MB".
  const [bufferedSec, setBufferedSec] = useState<number | null>(null);
  // Direct-mp4 size from the media-token response. Drives the
  // `computeBufferOverlay` "downloaded / needed" estimate from
  // `bufferedSec / durationSec × totalBytes`.
  const [videoTotalBytes, setVideoTotalBytes] = useState<number | null>(null);
  // Snapshotted at loadedmetadata/durationchange; drives the "to start"
  // byte threshold in the inline buffer overlay (see render).
  const [videoDurationSec, setVideoDurationSec] = useState<number | null>(null);

  // User-chosen height of the timeline section (persisted). The player flexes
  // to fill whatever's left above the splitter.
  const [timelineHeight, setTimelineHeight] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
      return Number.isFinite(v) && v >= MIN_TIMELINE_H ? v : DEFAULT_TIMELINE_H;
    } catch {
      return DEFAULT_TIMELINE_H;
    }
  });

  // Cameras the user has unchecked in the per-camera filter (hidden from rows).
  const [hiddenCameras, setHiddenCameras] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem(HIDDEN_CAMS_KEY); return new Set(raw ? JSON.parse(raw) as string[] : []); }
    catch { return new Set(); }
  });
  const [camFilterOpen, setCamFilterOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const camFilterRef = useRef<HTMLDivElement>(null);   // .timeline-camfilter-anchor — outside-click close
  const containerRef = useRef<HTMLDivElement>(null);   // .timeline-container — clamps the splitter
  const vScrollRef = useRef<HTMLDivElement>(null);     // .timeline-scroll-row — the vertical scroller
  const headerScrollRef = useRef<HTMLDivElement>(null);// sticky ruler scroll area
  const splitterRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hoverLineRef = useRef<SVGLineElement>(null);
  const playheadRef = useRef<SVGLineElement>(null);
  const playheadBufferDotRef = useRef<SVGCircleElement>(null);
  const playheadRafRef = useRef<number | null>(null);
  const hoverVisibleRef = useRef(false);
  const viewRef = useRef({ viewStart, viewEnd, timelineWidth: 800 });
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasDragged = useRef(false);
  const pendingClickTime = useRef<number | null>(null);
  const handleTimeClickRef = useRef<(time: number) => void>(() => {});
  // Mirror of `inlineVideo` for the stable bar-open path (mouse click + touch
  // long-press) — it must know what is playing without re-binding per clip.
  const inlineVideoStateRef = useRef<typeof inlineVideo>(null);
  // Mirror of `visibleEvents` so the long-press timer can resolve its bar's
  // event id back to a CameraEvent.
  const visibleEventsRef = useRef<CameraEvent[]>([]);

  // --- Precision mode ---
  // Plain click on a bar plays from the start; ⌘-click (Mac) / Ctrl-click or a
  // touch long-press seeks to the clicked point. The indicator (toolbar badge,
  // crosshair cursor, full-opacity hover line) shows while the modifier is
  // held with the pointer over the timeline, or briefly after a long-press.
  const [precisionHeld, setPrecisionHeld] = useState(false);
  const [pointerOverTimeline, setPointerOverTimeline] = useState(false);
  const [precisionFlash, setPrecisionFlash] = useState(false);
  const precisionFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMac] = useState(detectIsMac);
  const [finePointer] = useState(hasFinePointer);

  // Sync ref for non-React event handlers
  useEffect(() => {
    viewRef.current = { viewStart, viewEnd, timelineWidth: containerWidth };
  }, [viewStart, viewEnd, containerWidth]);

  useEffect(() => {
    inlineVideoStateRef.current = inlineVideo;
  }, [inlineVideo]);

  // ⌘/Ctrl tracking for the precision indicator. keyup reads the OTHER
  // modifier so releasing one of two held keys keeps the mode on; blur and
  // tab switches reset it because the matching keyup lands somewhere else.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') setPrecisionHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') setPrecisionHeld(e.ctrlKey);
      else if (e.key === 'Control') setPrecisionHeld(e.metaKey);
    };
    const reset = () => setPrecisionHeld(false);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);

  // Touch has no held modifier to show — flash the badge after a long-press
  // so the user learns why the clip didn't start from the beginning.
  const flashPrecisionBadge = useCallback(() => {
    setPrecisionFlash(true);
    if (precisionFlashTimerRef.current) clearTimeout(precisionFlashTimerRef.current);
    precisionFlashTimerRef.current = setTimeout(() => {
      precisionFlashTimerRef.current = null;
      setPrecisionFlash(false);
    }, PRECISION_FLASH_MS);
  }, []);

  // Same shape: cameraList is computed below from `eventsByCamera`. The
  // mousemove handler reads it via a ref so adding/removing a camera
  // doesn't force a fresh handler binding (which would otherwise rebind
  // the ResizeObserver-driven listeners 60 times during a drag).
  const cameraListRef = useRef<string[]>([]);

  // --- Layout ---
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      setContainerWidth(rect?.width ?? 800);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Persist the user's chosen timeline height.
  useEffect(() => {
    try { localStorage.setItem(TIMELINE_HEIGHT_KEY, String(Math.round(timelineHeight))); } catch { /* private mode */ }
  }, [timelineHeight]);

  // Persist hidden-camera selection.
  useEffect(() => {
    try { localStorage.setItem(HIDDEN_CAMS_KEY, JSON.stringify([...hiddenCameras])); } catch { /* private mode */ }
  }, [hiddenCameras]);

  // Close the camera-filter popover on outside click.
  useEffect(() => {
    if (!camFilterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (camFilterRef.current && !camFilterRef.current.contains(e.target as Node)) setCamFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [camFilterOpen]);

  // --- Data fetching (debounced) ---
  useEffect(() => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      ensureDatesFetched(viewStart, viewEnd);
    }, FETCH_DEBOUNCE_MS);
    return () => { if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current); };
  }, [viewStart, viewEnd, ensureDatesFetched]);

  // Immediate initial fetch
  const initialDone = useRef(false);
  useEffect(() => {
    if (!initialDone.current) {
      initialDone.current = true;
      ensureDatesFetched(viewStart, viewEnd);
    }
  }, [ensureDatesFetched, viewStart, viewEnd]);

  // --- Silent auto-refresh (60s) ---
  // Picks up clips that appeared / were deleted on already-loaded days without a
  // manual reload. Mirrors the grid's poll (GridView.tsx) but: (1) refreshes
  // only the visible range, (2) defers while the user is panning/zooming, and
  // (3) pauses on a hidden tab. Every view-range change stamps the interaction
  // clock — the now-line tick and refreshVisible itself don't touch the range,
  // so they never reset it.
  const lastInteractionRef = useRef(0);
  useEffect(() => {
    lastInteractionRef.current = Date.now();
  }, [viewStart, viewEnd]);

  useEffect(() => {
    const refreshNow = () => {
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      refreshVisible(vs, ve);
    };
    const id = setInterval(() => {
      if (shouldAutoRefresh({
        hidden: document.hidden,
        msSinceInteraction: Date.now() - lastInteractionRef.current,
        idleThresholdMs: AUTO_REFRESH_IDLE_MS,
      })) refreshNow();
    }, AUTO_REFRESH_MS);
    // Coming back to a backgrounded tab: refresh immediately (parity with iOS
    // foreground re-entry) instead of waiting up to a full interval.
    const onVisible = () => { if (!document.hidden) refreshNow(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshVisible]);

  // Scroll to last recording on initial load (only when URL had neither
  // ?date= nor ?event= on mount). With ?event= present, the hydration
  // effect below owns the initial state and runs `loadLatestAndPlay()`
  // itself as a 404 fallback.
  const scrolledToLatest = useRef(false);
  const loadLatestAndPlay = useCallback(() => {
    return api.getEvents({ limit: 1 }).then(({ events }) => {
      if (events.length === 0) return;
      const ev = events[0];
      // First open with no ?date=/?event=: frame the whole day of the latest
      // recording (00:00Z–24:00Z) so all of that day's events are visible at
      // once, rather than zooming to a ±1h window around the newest clip.
      const { viewStart, viewEnd } = dayViewForTimestamp(new Date(ev.timestamp).getTime());
      setViewStart(viewStart);
      setViewEnd(viewEnd);
      const initialView = ev.views[0]?.id;
      if (!initialView) return;
      setInlineVideo({ event: ev, view: initialView });
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (scrolledToLatest.current) return;
    if (hadDateParam.current || hadEventParam.current) { scrolledToLatest.current = true; return; }
    scrolledToLatest.current = true;
    loadLatestAndPlay();
  }, [loadLatestAndPlay]);

  // Hydrate inlineVideo from ?event=&view=&t= on mount. Runs at most once;
  // owns the initial-state path when the URL deep-links to a specific clip.
  // On 404: clear the dead params and fall through to loadLatestAndPlay so
  // the user lands somewhere usable. Transient errors keep the URL so a
  // refresh can retry — same idiom as AuthedShell.tsx.
  useEffect(() => {
    // react-router-dom v6's `setSearchParams` reference changes whenever the
    // URL changes (its useCallback closes over `searchParams`). Listing it in
    // deps re-fires this effect after every URL write — including the one our
    // own URL-sync effect at L295 does after the user clicks a different tile.
    // Without this guard, that re-fire re-fetches the ORIGINAL `?event=` from
    // the still-frozen `initialEventParams.current` ref and clobbers the
    // user's selection back to the deep-linked clip on every click.
    if (initialHydrationDone.current) return;
    const initial = initialEventParams.current;
    if (!initial) return;
    let cancelled = false;
    api.getEvent(initial.eventId).then(({ event }) => {
      if (cancelled) return;
      const ts = new Date(event.timestamp).getTime();
      if (!hadDateParam.current && Number.isFinite(ts)) {
        const margin = 3600_000;
        setViewStart(ts - margin);
        setViewEnd(ts + margin);
      }
      // Clamp `?t=N` against the event's known duration before it enters
      // state. URL serializer rounds seekSec to int, so a bookmark from
      // the last second of an N.x-second clip writes `?t=N+1` which
      // would otherwise lock trySeek's broken-moov nudge for 60 s.
      // trySeek applies the same clamp as defense in depth (event may
      // arrive without `duration` for legacy rows).
      const clampedSeek = clampSeekToDuration(initial.seekSec, event.duration);
      setInlineVideo({
        event,
        view: initial.view,
        seekSec: clampedSeek ?? undefined,
      });
      initialHydrationDone.current = true;
    }).catch((err: unknown) => {
      if (cancelled) return;
      const isGone = err instanceof ApiError && err.status === 404;
      if (isGone) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.delete('event');
          next.delete('view');
          next.delete('t');
          return next;
        }, { replace: true, preventScrollReset: true });
        loadLatestAndPlay().finally(() => { initialHydrationDone.current = true; });
      } else {
        initialHydrationDone.current = true;
      }
    });
    return () => { cancelled = true; };
  }, [loadLatestAndPlay, setSearchParams]);

  // Date is NOT synced back to the URL — `?date=` is read on mount (old
  // bookmarks like `/timeline?date=2026-01-15` still land on that day) but
  // panning/zooming the timeline does NOT write it back. Two reasons:
  //   1. The viewport state isn't worth a URL entry — `?event=` already
  //      anchors the viewport to a meaningful clip and is restored on
  //      refresh by the hydration effect above.
  //   2. Every pan-driven `setSearchParams` triggered downstream re-renders
  //      that, in a corner case the user surfaced, re-bound the <video>
  //      `src` and the deferred-seek effect re-applied `inlineVideo.seekSec`
  //      — i.e. dragging the timeline yanked the playhead back to the
  //      user's last explicit click position. Removing the write breaks
  //      that chain at the source.

  // Sync inlineVideo (event/view/t) to URL — debounce + no-op short-circuit
  // matches the deleted date sync's pattern, kept here for the iOS Safari
  // replaceState-cap reason.
  // Gated on `initialHydrationDone` so the first render — when inlineVideo is
  // still null but the URL already has ?event= waiting to hydrate — doesn't
  // briefly clear the params before getEvent() resolves.
  useEffect(() => {
    if (!initialHydrationDone.current) return;
    const handle = setTimeout(() => {
      const { event, view, t } = serializeInlineVideoToParams(inlineVideo);
      setSearchParams(() => {
        // Read live URL via window.location.search rather than React's
        // `prev` snapshot — `prev` lags actual URL by one render, so when
        // this fires right after the sibling date-sync write at L286 the
        // stale `prev` would have us write `?event=...` from scratch and
        // clobber the date that just landed.
        const current = new URLSearchParams(window.location.search);
        if (current.get('event') === event && current.get('view') === view && current.get('t') === t) return current;
        if (event) current.set('event', event); else current.delete('event');
        if (view) current.set('view', view); else current.delete('view');
        if (t) current.set('t', t); else current.delete('t');
        return current;
      }, { replace: true, preventScrollReset: true });
    }, 250);
    return () => clearTimeout(handle);
  }, [inlineVideo, setSearchParams]);

  // --- Computed ---
  const timelineWidth = containerWidth;
  const viewDuration = viewEnd - viewStart;

  const visibleEvents = useMemo(() => {
    const dates = getDatesInRange(viewStart, viewEnd);
    return dates.flatMap(d => eventsByDate[d] || []);
  }, [viewStart, viewEnd, eventsByDate]);

  const eventsByCamera = useMemo(() => {
    const map = new Map<string, CameraEvent[]>();
    for (const ev of visibleEvents) {
      const arr = map.get(ev.camera) || [];
      arr.push(ev);
      map.set(ev.camera, arr);
    }
    return map;
  }, [visibleEvents]);

  // Rows actually drawn = cameras with visible events MINUS the ones the user
  // unchecked in the filter. Filtering here is enough: cameraList is the spine
  // of the whole render (rows, bars, sidebar labels, rowsHeight, hover math).
  const cameraList = useMemo(
    () => Array.from(eventsByCamera.keys()).filter(c => !hiddenCameras.has(c)).sort(),
    [eventsByCamera, hiddenCameras],
  );

  // Full camera universe for the filter checklist: the user's whole camera set
  // unioned with any camera that has events in view (so a camera with no events
  // right now is still listed and checkable). NOT affected by the hide-filter.
  const allKnownCameras = useMemo(
    () => Array.from(new Set([...allCameras, ...eventsByCamera.keys()])).sort(),
    [allCameras, eventsByCamera],
  );
  const shownCamCount = useMemo(
    () => allKnownCameras.filter(c => !hiddenCameras.has(c)).length,
    [allKnownCameras, hiddenCameras],
  );
  // Mirror to a ref so the mouse-move handler can resolve cursor Y →
  // camera without re-binding when the list changes.
  useEffect(() => { cameraListRef.current = cameraList; }, [cameraList]);
  useEffect(() => { visibleEventsRef.current = visibleEvents; }, [visibleEvents]);

  // Row height: fixed ROW_HEIGHT. The camera rows live in their own vertical
  // scroll container (.timeline-scroll-row) so any number of cameras stays
  // reachable; the time-axis ruler is a separate sticky band above them. So
  // this is the height of JUST the rows (no header band baked in).
  const numCameras = Math.max(cameraList.length, 1);
  const dynamicRowHeight = ROW_HEIGHT;
  const rowsHeight = numCameras * dynamicRowHeight;

  const cameraColorMap = useMemo(
    // Palette is computed over the user's FULL camera set (allCameras),
    // not just the cameras with visible bars (cameraList). Otherwise a
    // zoom that drops the last bar of camera X out of the window would
    // remove X from the palette input → both `offset` (set-hash seed)
    // and `step` (360/N) recompute → every other camera shifts hue. The
    // bug report on 2026-05-03 was exactly this: zooming flipped colours.
    // We union with cameraList as a fallback for the brief moment after
    // mount when allCameras hasn't loaded yet (paletteForCameras dedupes).
    () => paletteForCameras([...allCameras, ...cameraList]),
    [allCameras, cameraList],
  );

  const timeToX = useCallback((t: number) => {
    return ((t - viewStart) / viewDuration) * timelineWidth;
  }, [viewStart, viewDuration, timelineWidth]);

  // --- Ticks ---
  // Axis lives in "event wall-clock" time — event.timestamp is stored as
  // `HH:MM:SSZ` where HH:MM is the camera's local clock (see utils/format
  // eventDateAsLocal). Bucketing by UTC midnight + formatting in UTC keeps
  // the ticks reading the same digits as the filenames and the card labels.
  const ticks = useMemo(() => {
    const { interval } = getTickInterval(viewDuration, timelineWidth);
    const result: { time: number; label: string; isMajor: boolean }[] = [];
    const utcMidnight = new Date(viewStart);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const utcMidnightMs = utcMidnight.getTime();
    const start = utcMidnightMs + Math.ceil((viewStart - utcMidnightMs) / interval) * interval;
    for (let t = start; t <= viewEnd; t += interval) {
      const d = new Date(t);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      result.push({ time: t, label: `${hh}:${mm}`, isMajor: d.getUTCHours() === 0 && d.getUTCMinutes() === 0 });
    }
    return result;
  }, [viewStart, viewEnd, viewDuration, timelineWidth]);

  // Day boundary lines (midnight markers when zoomed out). Same UTC-wall-
  // clock convention as ticks — the boundary lines up with the filename
  // date, not the browser's midnight.
  const dayBoundaries = useMemo(() => {
    if (viewDuration < 3 * 3600_000) return [];
    const result: { time: number; label: string }[] = [];
    const d = new Date(viewStart);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getTime() <= viewEnd) {
      result.push({ time: d.getTime(), label: format(d, 'EEE d MMM', { locale }) });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return result;
  }, [viewStart, viewEnd, viewDuration, locale]);

  // --- Now line ---
  // `now` is kept in the SAME wall-clock-baked-as-UTC frame as the ticks, the
  // day boundaries and the event bars — i.e. real `Date.now()` projected onto
  // the account's clock. Storing the raw instant here (the pre-2026-07-31
  // behaviour) drew the green line `offset` hours away from the newest clips:
  // two hours to their left for a Europe/Warsaw account in summer. iOS,
  // Android and Windows all convert at exactly this point too.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(nowWallClock(Date.now(), accountTz));
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [accountTz]);
  const showNow = now > 0 && now >= viewStart && now <= viewEnd;

  // Detail panel is always visible at the top — no scrollIntoView needed.

  // --- Hover tooltip events ---
  // Pre-fix: every camera whose events fell within a time window of the
  // cursor showed a thumbnail, deduped by camera. That meant scrubbing
  // the cursor across the timeline always lit up "the closest event for
  // every camera around me" — useful as a side panel, confusing as a
  // hover tooltip.
  // Post-fix: thumbnails show ONLY for events on the camera row the
  // cursor is actually hovering over, AND only when a bar exists within
  // a one-bar-width window of the cursor. Multiple events overlapping
  // at the same camera+time are all shown (the unusual dual-recording
  // case the user called out — not deduped).
  const hoverQuantized = hoverTime !== null ? Math.round(hoverTime / HOVER_QUANTIZE_MS) : null;
  const pixelDuration = viewDuration / timelineWidth;
  const visualBarDuration = Math.max(EVENT_DURATION_MS, MIN_BAR_WIDTH * pixelDuration);
  const HOVER_TOLERANCE_MS = visualBarDuration;
  const hoverEvents = useMemo(() => {
    if (hoverTime === null || hoverQuantized === null || hoverCamera === null) return [];
    return visibleEvents.filter(ev =>
      ev.camera === hoverCamera &&
      Math.abs(new Date(ev.timestamp).getTime() - hoverTime) <= HOVER_TOLERANCE_MS,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverQuantized, hoverCamera, visibleEvents]);

  // --- Date label ---
  const dateRangeLabel = useMemo(() => {
    // `viewStart`/`viewEnd` are UTC-midnight-aligned instants on the wall-clock
    // axis, so the calendar day they name must be read with UTC getters — the
    // old local read labelled the whole view one day early for any browser west
    // of Greenwich. Both branches then format from a LOCAL noon Date, because
    // date-fns formats with local getters and noon survives every offset.
    // "Today" is the account clock's today, matching the bars on screen.
    const startStr = toUtcDateStr(new Date(viewStart));
    const endStr = toUtcDateStr(new Date(viewEnd));
    const asNoon = (ymd: string) => new Date(ymd + 'T12:00:00');
    if (startStr === endStr || (viewEnd - viewStart) <= 86400_000) {
      // `now` is already projected onto the account clock, so its UTC date IS
      // today on that clock — and reusing it keeps the label in lockstep with
      // the now-line instead of letting the two disagree over a midnight tick.
      if (now > 0 && startStr === toUtcDateStr(new Date(now))) return t('timeline.today');
      return format(asNoon(startStr), 'EEEE, d MMMM yyyy', { locale });
    }
    return `${format(asNoon(startStr), 'd MMM', { locale })} \u2013 ${format(asNoon(endStr), 'd MMM yyyy', { locale })}`;
  }, [viewStart, viewEnd, locale, t, now]);

  // === Zoom helper (reads from ref, no deps) ===
  const applyZoom = useCallback((factor: number, anchorX: number) => {
    const { viewStart: vs, viewEnd: ve, timelineWidth: tw } = viewRef.current;
    const duration = ve - vs;
    let newDuration = duration * factor;
    newDuration = Math.max(MIN_VIEW_MS, Math.min(MAX_VIEW_MS, newDuration));
    const ratio = anchorX / tw;
    const anchorTime = vs + ratio * duration;
    setViewStart(anchorTime - ratio * newDuration);
    setViewEnd(anchorTime - ratio * newDuration + newDuration);
  }, []);

  // --- Wheel zoom (non-passive for preventDefault) ---
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // When there are more camera rows than fit, a plain vertical wheel should
      // scroll the rows (the whole point of the many-cameras fix), not zoom.
      // Zoom then lives on Ctrl/Cmd+wheel. With few cameras (nothing to scroll)
      // plain wheel keeps zooming exactly as before.
      const vs = vScrollRef.current;
      const canScrollV = !!vs && vs.scrollHeight > vs.clientHeight + 1;
      if (canScrollV && !e.ctrlKey && !e.metaKey) return; // let the browser scroll .timeline-scroll-row
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      applyZoom(e.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, mouseX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  // --- Open a bar's clip at `seekSec` ---
  // Single path for the mouse click (plain / ⌘-Ctrl) and the touch long-press.
  // When the target equals what is already playing, the VideoZoom remount key
  // (`${id}-${view}-${seekSec}`) would not change, so pushing state would do
  // nothing visible — restart the live <video> in place instead. That is what
  // makes a plain re-click of the playing clip start it over from 0.
  const openBarAt = useCallback((ev: CameraEvent, seekSec: number) => {
    const view = ev.views[0]?.id;
    if (!view) return;
    const cur = inlineVideoStateRef.current;
    const v = inlineVideoRef.current;
    const current = cur ? { eventId: cur.event.id, view: cur.view, seekSec: cur.seekSec } : null;
    if (v && isSameClipSeek(current, ev.id, view, seekSec)) {
      v.currentTime = seekSec;
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return;
    }
    setInlineVideo({ event: ev, view, seekSec });
  }, []);

  // --- Pointer events (drag + pinch) ---
  const pointersRef = useRef(new Map<number, number>());
  // Touch long-press on a bar → precision seek. Armed on pointerdown over a
  // bar; cancelled by moving past TOUCH_DRAG_THRESHOLD, a second finger,
  // pointerup / pointercancel, or unmount.
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  // True once a long-press fired in the current gesture — lets the
  // contextmenu handler swallow the OS menu. Reset on the next pointerdown.
  const longPressFiredRef = useRef(false);
  const cancelLongPress = useCallback(() => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  }, []);
  const clearPrecisionFlashTimer = useCallback(() => {
    if (!precisionFlashTimerRef.current) return;
    clearTimeout(precisionFlashTimerRef.current);
    precisionFlashTimerRef.current = null;
  }, []);
  useEffect(() => () => {
    cancelLongPress();
    clearPrecisionFlashTimer();
  }, [cancelLongPress, clearPrecisionFlashTimer]);
  const lastPinchDist = useRef(0);
  const isDragging = useRef(false);
  const dragStartRef = useRef({ x: 0, viewStart: 0, viewEnd: 0, pointerType: '' });
  // Pinch-zoom RAF batch — coalesces high-frequency pointermove events into
  // one setState per frame. iOS Firefox in particular crashed with a black
  // screen when pinch fired ~120 setState pairs/sec against the SVG bar grid.
  const pinchRafRef = useRef<number | null>(null);
  const pinchPendingRef = useRef<{ factor: number; anchorX: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointersRef.current.set(e.pointerId, e.clientX);
    wasDragged.current = false;
    longPressFiredRef.current = false;
    cancelLongPress(); // a second finger turns a pending long-press into a pinch

    if (pointersRef.current.size === 1 && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
      const bar = e.target instanceof Element ? e.target.closest('rect[data-event-id]') : null;
      const eventId = bar?.getAttribute('data-event-id');
      if (bar && eventId) {
        // Snapshot the press point + bar box now: any sub-threshold jitter pans
        // bar and finger together, so their relative offset stays valid.
        const box = bar.getBoundingClientRect();
        const pressX = e.clientX;
        longPressRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          timer: setTimeout(() => {
            longPressRef.current = null;
            const ev = visibleEventsRef.current.find(x => x.id === eventId);
            if (!ev) return;
            const clipLenSec = ev.duration ?? EVENT_DURATION_MS / 1000;
            const seekSec = barClickSeekSec(pressX, box.left, box.width, clipLenSec, true);
            // The long-press consumes the gesture: wasDragged suppresses the
            // synthesized click (bar + background — it resets on the next
            // pointerdown) and isDragging stops the finger from panning on.
            wasDragged.current = true;
            isDragging.current = false;
            pendingClickTime.current = null;
            longPressFiredRef.current = true;
            openBarAt(ev, seekSec);
            try {
              if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
            } catch { /* blocked without user activation — haptics are optional */ }
            flashPrecisionBadge();
          }, LONG_PRESS_MS),
        };
      }
    }

    if (pointersRef.current.size === 1) {
      isDragging.current = true;
      setCursorGrabbing(true);
      // Hide via the property — setAttribute('style', 'display:none') would
      // wipe the inline `pointer-events: none` set in JSX, leaving the hover
      // line clickable on the next render and stealing bar clicks.
      if (hoverLineRef.current) hoverLineRef.current.style.display = 'none';
      dragStartRef.current = {
        x: e.clientX,
        viewStart: viewRef.current.viewStart,
        viewEnd: viewRef.current.viewEnd,
        pointerType: e.pointerType,
      };
      // NOTE: setPointerCapture is deferred to handlePointerMove (only when
      // drag threshold is exceeded). Capturing eagerly redirects pointerup
      // to scrollRef, which makes the synthesized click event fire on the
      // <div> instead of the actual <rect> bar — handleBarClick never runs
      // and the bar-click seek silently falls back to "play from 0".
    } else if (pointersRef.current.size >= 2) {
      isDragging.current = false;
      // Multi-touch pinch needs capture immediately so we keep tracking both
      // pointers when fingers slide outside the timeline.
      scrollRef.current?.setPointerCapture(e.pointerId);
      const xs = Array.from(pointersRef.current.values());
      lastPinchDist.current = Math.abs(xs[0] - xs[1]);
    }
  }, [cancelLongPress, openBarAt, flashPrecisionBadge]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    pointersRef.current.set(e.pointerId, e.clientX);

    // A finger that travels is panning, not pressing.
    const lp = longPressRef.current;
    if (lp && lp.pointerId === e.pointerId
      && Math.hypot(e.clientX - lp.startX, e.clientY - lp.startY) > TOUCH_DRAG_THRESHOLD) {
      cancelLongPress();
    }

    if (pointersRef.current.size >= 2) {
      // Pinch zoom — coalesce multiple touchmove events into one rAF callback
      // so we apply at most one zoom step per frame instead of per touch event.
      const xs = Array.from(pointersRef.current.values());
      const dist = Math.abs(xs[0] - xs[1]);
      if (lastPinchDist.current > 10 && dist > 10) {
        const factor = lastPinchDist.current / dist;
        const rect = scrollRef.current?.getBoundingClientRect();
        if (rect) {
          pinchPendingRef.current = { factor, anchorX: (xs[0] + xs[1]) / 2 - rect.left };
          if (pinchRafRef.current === null) {
            pinchRafRef.current = requestAnimationFrame(() => {
              pinchRafRef.current = null;
              const pending = pinchPendingRef.current;
              pinchPendingRef.current = null;
              if (pending) applyZoom(pending.factor, pending.anchorX);
            });
          }
        }
        wasDragged.current = true;
      }
      lastPinchDist.current = dist;
    } else if (isDragging.current && pointersRef.current.size === 1) {
      // Pan
      const dx = e.clientX - dragStartRef.current.x;
      const threshold = dragStartRef.current.pointerType === 'touch'
        ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;
      if (Math.abs(dx) > threshold) {
        // Promote to a real drag. Acquire pointer capture now so the gesture
        // keeps panning when the cursor leaves the timeline. We hold off
        // until threshold is crossed because eager capture would steal the
        // synthesized click event from <rect> bars (see handlePointerDown).
        if (!wasDragged.current) {
          scrollRef.current?.setPointerCapture(e.pointerId);
        }
        wasDragged.current = true;
      }

      const duration = dragStartRef.current.viewEnd - dragStartRef.current.viewStart;
      const tw = viewRef.current.timelineWidth;
      const timeDelta = -(dx / tw) * duration;

      setViewStart(dragStartRef.current.viewStart + timeDelta);
      setViewEnd(dragStartRef.current.viewEnd + timeDelta);
    }
  }, [applyZoom, cancelLongPress]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    cancelLongPress(); // lifted before LONG_PRESS_MS → an ordinary tap
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      lastPinchDist.current = 0;
      // Cancel any pending RAF zoom — we don't want a stale frame to fire
      // after the user lifted both fingers.
      if (pinchRafRef.current !== null) {
        cancelAnimationFrame(pinchRafRef.current);
        pinchRafRef.current = null;
        pinchPendingRef.current = null;
      }
    }
    if (pointersRef.current.size === 0) {
      isDragging.current = false;
      setCursorGrabbing(false);

      // Click-to-select: if pointer was released without dragging, schedule time selection.
      // We handle this here because setPointerCapture prevents click events from
      // reaching the SVG's onClick handler. We use requestAnimationFrame so that
      // if a bar's onClick fires (synchronously after pointerup), it can cancel
      // the pending background click via pendingClickTime ref.
      if (!wasDragged.current) {
        const rect = scrollRef.current?.getBoundingClientRect();
        if (rect) {
          const mouseX = e.clientX - rect.left;
          if (mouseX >= 0 && mouseX <= rect.width) {
            const time = viewRef.current.viewStart +
              (mouseX / viewRef.current.timelineWidth) *
              (viewRef.current.viewEnd - viewRef.current.viewStart);
            pendingClickTime.current = time;
            requestAnimationFrame(() => {
              if (pendingClickTime.current !== null) {
                handleTimeClickRef.current(pendingClickTime.current);
                pendingClickTime.current = null;
              }
            });
          }
        }
      }
    }
  }, [cancelLongPress]);

  // A cancelled pointer (the browser took the gesture over) is not a tap:
  // same bookkeeping as pointerup, but flagged as dragged so no background
  // click gets scheduled. wasDragged resets on the next pointerdown.
  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    cancelLongPress();
    wasDragged.current = true;
    handlePointerUp(e);
  }, [cancelLongPress, handlePointerUp]);

  // Long-press on touch would otherwise open the OS context menu (Android)
  // on top of the clip we just started.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (longPressRef.current || longPressFiredRef.current) e.preventDefault();
  }, []);

  // --- Button handlers ---
  const handleZoomIn = useCallback(() => applyZoom(1 / ZOOM_FACTOR, viewRef.current.timelineWidth / 2), [applyZoom]);
  const handleZoomOut = useCallback(() => applyZoom(ZOOM_FACTOR, viewRef.current.timelineWidth / 2), [applyZoom]);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const handlePickDate = useCallback((d: Date) => {
    // Frame the picked calendar day as a full UTC day (matches the ?date=
    // default and the event-bucket boundaries — see timelineDayView).
    const { viewStart, viewEnd } = dayViewForDateStr(toLocalDateStr(d));
    setViewStart(viewStart);
    setViewEnd(viewEnd);
  }, []);
  // Auto-close the date picker after any timeline interaction that moves
  // the view or swaps the active player. The picker's own outside-click
  // handler already covers raw clicks on the SVG, but bar / zoom / view
  // / time-legend handlers update component state directly without
  // necessarily generating a `mousedown` on the document the picker is
  // listening on (e.g., when the click was delivered via dispatchEvent
  // in an e2e or via a synthetic source). Closing on the visible side-
  // effects of those handlers — viewStart/End change or inlineVideo
  // identity change — keeps the calendar from lingering on top of the
  // timeline after the user moved on.
  useEffect(() => {
    setDatePickerOpen(false);
  }, [viewStart, viewEnd, inlineVideo?.event.id]);

  // --- Inline video player ---
  const handleInlinePlay = useCallback((ev: CameraEvent, view: ViewId) => {
    // View switch on the same event (wide↔zoom toggle) should pick up
    // where the user left off, not jump back to t=0. Same deferred-seek
    // mechanism the bar-click and time-legend-click use: park seekSec
    // on inlineVideo and let the trySeek effect retry until duration
    // catches up. For a fresh event (different id) or repeated view
    // (same id, same view — the user wants to restart) we leave seekSec
    // undefined so playback starts at zero.
    const cur = inlineVideoRef.current;
    const isViewSwitch = inlineVideo
      && inlineVideo.event.id === ev.id
      && inlineVideo.view !== view;
    const seekSec = isViewSwitch && cur && Number.isFinite(cur.currentTime) && cur.currentTime > 0.5
      ? cur.currentTime
      : undefined;
    setInlineVideo({ event: ev, view, seekSec });
    setInlineVideoSrc(null);
    setPlayerMenuOpen(false);
  }, [inlineVideo]);

  // Resolve inline video URL asynchronously via media token. Backend serves
  // a clean faststart MP4 on the `?fmt=clean` direct endpoint so we just
  // bind the plain mp4 URL — no second round-trip for a Range:bytes=0-0
  // probe.
  useEffect(() => {
    if (!inlineVideo) { setInlineVideoSrc(null); setVideoTotalBytes(null); setInlineFrameGrid([]); return; }
    let cancelled = false;
    setInlineLocked(false);
    setVideoTotalBytes(null);
    setInlineFrameGrid([]);
    api.getVideoUrl(inlineVideo.event.id, inlineVideo.view)
      .then(({ videoUrl, totalBytes }) => {
        if (cancelled) return;
        // No `#t=seekSec` media fragment: Reolink moov atoms can report a wrong
        // (short) duration, which clamps the fragment seek. The deferred-seek
        // effect (trySeek) lands the click reliably; the loading overlay stays
        // up until its `seeked` fires, so frame 0 never shows.
        setInlineVideoSrc(videoUrl);
        setVideoTotalBytes(totalBytes);
        // Front-load the real presentation-time grid so frame-stepping walks
        // the actual VFR frames (Reolink) instead of the fixed-fps fallback.
        api.getFrameGrid(inlineVideo.event.id, inlineVideo.view)
          .then(g => { if (!cancelled) setInlineFrameGrid(g); })
          .catch(() => {});
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403 && err.body?.code === 'ACCOUNT_LOCKED') setInlineLocked(true);
      });
    return () => { cancelled = true; };
  }, [inlineVideo]);

  // Bind the player source. Clips are short (Reolink) and the server serves
  // a clean faststart MP4 (front-loaded moov) on the `?fmt=clean` direct
  // endpoint, so a plain progressive `<video src>` plays fine — no
  // HLS/MSE/segmentation needed. Mirrors the VideoPlayer fullscreen path.
  useEffect(() => {
    const video = inlineVideoRef.current;
    if (!video) return;
    if (!inlineVideoSrc) return;
    video.src = inlineVideoSrc;
    video.load();
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }, [inlineVideoSrc]);

  // --- Playhead sync with inline video ---
  // DOM-ref based positioning (no React re-render per frame). Reads the
  // video element's currentTime, adds to the event's start timestamp to
  // get an absolute ms-since-epoch, projects to x via the same timeToX
  // math used for static bars. Called on every rAF while the video is
  // playing, plus on discrete events (seek, loadedmetadata, pause) and
  // whenever the user pans/zooms the timeline.
  const updatePlayhead = useCallback(() => {
    const line = playheadRef.current;
    const video = inlineVideoRef.current;
    if (!line) return;
    if (!inlineVideo) return;
    const eventStartMs = new Date(inlineVideo.event.timestamp).getTime();
    // Before <video> mounts or before its metadata lands, currentTime stays
    // at 0 even when we asked for a non-zero seek via #t=N. Pin the playhead
    // at the requested seekSec until the video actually catches up — keeps
    // it from flashing back to the event-start for one frame on every click.
    const ct = video?.currentTime || 0;
    const requestedSeek = inlineVideo.seekSec || 0;
    const positionSec = ct > 0 ? ct : requestedSeek;
    const currentMs = eventStartMs + positionSec * 1000;
    const { viewStart: vs, viewEnd: ve, timelineWidth: tw } = viewRef.current;
    const duration = ve - vs;
    if (duration <= 0 || tw <= 0) return;
    const x = ((currentMs - vs) / duration) * tw;
    line.setAttribute('x1', String(x));
    line.setAttribute('x2', String(x));
    // Keep the buffer-pulse dot anchored to the same x as the playhead.
    playheadBufferDotRef.current?.setAttribute('cx', String(x));
  }, [inlineVideo]);

  // Attach video element listeners — start/stop the rAF loop + catch discrete
  // seek / loadedmetadata / ended events so the playhead stays in sync even
  // when rAF isn't running (paused/ended).
  useEffect(() => {
    const video = inlineVideoRef.current;
    if (!video || !inlineVideo) return;

    const tick = () => {
      updatePlayhead();
      // Keep the loop alive only while the video is actually advancing —
      // pause/ended stop the rAF; play re-arms it.
      if (!video.paused && !video.ended) {
        playheadRafRef.current = requestAnimationFrame(tick);
      } else {
        playheadRafRef.current = null;
      }
    };

    const onPlay = () => {
      if (playheadRafRef.current === null) {
        playheadRafRef.current = requestAnimationFrame(tick);
      }
    };
    const onPauseOrEnd = () => {
      if (playheadRafRef.current !== null) {
        cancelAnimationFrame(playheadRafRef.current);
        playheadRafRef.current = null;
      }
      updatePlayhead(); // snap to final frame position
    };
    const onSeeked = () => updatePlayhead();
    const onLoadedMetadata = () => updatePlayhead();

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPauseOrEnd);
    video.addEventListener('ended', onPauseOrEnd);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    // Kick off an immediate update so the playhead reflects the seekSec the
    // bar-click handler baked into the URL fragment, even before `play`
    // fires.
    updatePlayhead();

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPauseOrEnd);
      video.removeEventListener('ended', onPauseOrEnd);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      if (playheadRafRef.current !== null) {
        cancelAnimationFrame(playheadRafRef.current);
        playheadRafRef.current = null;
      }
    };
  }, [inlineVideo, inlineVideoSrc, updatePlayhead]);

  // Re-project playhead on pan/zoom so it stays anchored to the video's
  // current wall-clock time, not to a fixed pixel.
  useEffect(() => {
    updatePlayhead();
  }, [viewStart, viewEnd, containerWidth, updatePlayhead]);

  // --- Deferred seek ----------------------------------------------------
  // Reolink firmware sometimes ships MP4s whose moov atom claims a wrong
  // duration (we've seen 5 s reported for a 2:05 clip). When the user
  // clicks the middle of a bar, the requested offset can fall outside the
  // *perceived* duration — at that point the browser will refuse to
  // seek (or silently snap to a fake EOF).
  //
  // Two-stage strategy:
  //   1. Park the requested seek in a closure variable. If the perceived
  //      duration already covers it, just apply.
  //   2. Otherwise nudge currentTime toward the perceived end so the
  //      browser fetches that byte range; parsing the new chunks often
  //      extends the perceived duration via `durationchange`, and we
  //      retry. Without the nudge, browsers (notably Chrome) leave
  //      duration locked at the moov-reported value forever and
  //      late-half clicks (seekSec > perceived duration) never landed —
  //      they just played from t=0 and stayed there.
  //
  // The retry runs on `loadedmetadata`, `durationchange`, AND `seeked`
  // (some browsers fire durationchange after seeked, not before). Bails
  // after 60 s so we don't yank the player around if the user has been
  // scrubbing manually for a while.
  useEffect(() => {
    const v = inlineVideoRef.current;
    if (!v || !inlineVideo) return;
    const seekSec = inlineVideo.seekSec ?? 0;
    if (seekSec <= 0) return;

    let pending: number | null = seekSec;
    let lastNudge = -1;
    setSeekPending(true);

    // Threshold separating "tiny overshoot of perceived end" (clamp,
    // duration is probably correct) from "wildly past perceived end"
    // (nudge — likely a broken Reolink moov atom that needs more bytes
    // fetched to discover the real duration). 5 s is empirically far
    // beyond what `Math.round` in the URL serializer can add (≤ 0.5 s)
    // and far beneath the gaps we've observed in broken-moov cases
    // (5 s reported / 125 s actual).
    const BROKEN_MOOV_GAP = 5;

    const trySeek = () => {
      if (pending === null) return;
      if (!Number.isFinite(v.duration) || v.duration <= 0) return;

      if (pending < v.duration - 0.25) {
        v.currentTime = pending;
        pending = null;
        lastNudge = -1;
        // Don't drop the overlay here — `currentTime =` only *initiates* the
        // seek. The `seeked` handler clears seekPending once the target frame is
        // actually decoded, so frame 0 never shows in the gap.
        return;
      }

      // Pending offset is at/past the perceived end. If it's only a tiny
      // overshoot, trust the duration and clamp — landing here from the
      // 60 s nudge loop was the v0.10.223 hang bug (`?t=13` on a
      // 13.018 s clip → "Seeking…" overlay until give-up timer fired).
      if (pending < v.duration + BROKEN_MOOV_GAP) {
        const clamped = clampSeekToDuration(pending, v.duration);
        if (clamped !== null) {
          v.currentTime = clamped;
          pending = null;
          lastNudge = -1;
          // Overlay cleared by the `seeked` handler (see above).
        }
        return;
      }

      // Pending offset is far past the perceived end. Nudge currentTime
      // to near-EOF so the browser fetches that region and (hopefully)
      // discovers more of the file. We track the duration we last
      // nudged at so we keep escalating only when duration actually
      // grew — otherwise we'd loop on a file whose duration is truly
      // locked, fighting the user's manual scrubs.
      const nearEnd = Math.max(0, v.duration - 0.5);
      if (v.duration > lastNudge + 0.25) {
        lastNudge = v.duration;
        if (Math.abs(v.currentTime - nearEnd) > 0.5) {
          v.currentTime = nearEnd;
        }
      }
    };

    // Race: <video> may have already fired loadedmetadata before the
    // effect ran. trySeek itself bails if duration isn't finite yet, so
    // calling it unconditionally is safe and lets us react immediately
    // when duration is already known at mount time.
    trySeek();

    // Clear the loading overlay only once a `seeked` fires AFTER the final seek
    // was applied (pending nulled) — i.e. the clicked-moment frame is actually
    // decoded and on screen. A nudge seek (pending still set) just retries
    // trySeek. This is what stops frame 0 from flashing between `currentTime =`
    // and the seek completing.
    const onSeeked = () => {
      if (pending === null) setSeekPending(false);
      trySeek();
    };
    v.addEventListener('loadedmetadata', trySeek);
    v.addEventListener('durationchange', trySeek);
    v.addEventListener('seeked', onSeeked);
    const giveUpTimer = setTimeout(() => {
      pending = null;
      setSeekPending(false);
    }, 60_000);

    return () => {
      v.removeEventListener('loadedmetadata', trySeek);
      v.removeEventListener('durationchange', trySeek);
      v.removeEventListener('seeked', onSeeked);
      clearTimeout(giveUpTimer);
      setSeekPending(false);
    };
  }, [inlineVideo, inlineVideoSrc]);

  // Track <video> load + buffer state. `loadstart` / `loadeddata` cover the
  // initial fetch (no first frame yet); `waiting` / `playing` / `canplay`
  // cover stalls *during* playback. The opaque "Loading video…" overlay
  // is intentionally limited to the INITIAL load — once the user has seen
  // the first frame, mid-playback `waiting` events (network slower than
  // decode rate) used to flip the overlay back on and hide the video +
  // native controls, so the user could no longer seek back, see how much
  // was buffered, or estimate time remaining. After first-frame, we trust
  // the browser's built-in buffering spinner on the native <video> chrome
  // and keep the overlay off. Reset on every video swap (new event /
  // new view / new src) by re-running the effect.
  useEffect(() => {
    const v = inlineVideoRef.current;
    if (!v) return;
    let firstFrameSeen = v.readyState >= 2;
    // Default to "buffering" until the element's first frame is ready —
    // <video> mounts before it has fetched anything, and on a fresh mount
    // loadstart fires synchronously inside the browser before our handler
    // attaches, so we'd miss it without seeding the state.
    setVideoBuffering(!firstFrameSeen);
    setBufferedSec(null);
    setVideoDurationSec(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    const onWaiting = () => {
      if (firstFrameSeen) return; // mid-playback stall → let native UI handle it
      setVideoBuffering(true);
    };
    const onResume = () => {
      firstFrameSeen = true;
      setVideoBuffering(false);
    };
    const onProgress = () => {
      if (!v.buffered.length || !Number.isFinite(v.duration) || v.duration <= 0) return;
      let sum = 0;
      for (let i = 0; i < v.buffered.length; i++) sum += v.buffered.end(i) - v.buffered.start(i);
      setBufferedSec(sum);
    };
    const onDurationChange = () => {
      setVideoDurationSec(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    };
    v.addEventListener('loadstart', onWaiting);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('loadeddata', onResume);
    v.addEventListener('playing', onResume);
    v.addEventListener('canplay', onResume);
    v.addEventListener('progress', onProgress);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('loadedmetadata', onDurationChange);
    return () => {
      v.removeEventListener('loadstart', onWaiting);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('loadeddata', onResume);
      v.removeEventListener('playing', onResume);
      v.removeEventListener('canplay', onResume);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('loadedmetadata', onDurationChange);
      setVideoBuffering(false);
    };
  }, [inlineVideo, inlineVideoSrc]);

  // (Removed: dedicated Range:bytes=0-0 probe-fetch. videoTotalBytes is
  // now sourced from the media-token response above — same auth, one
  // fewer round trip per video load on slow connections.)

  // Auto-retry the source when the network stalls during initial load. The
  // hook owns its own listeners + timers; it does not touch currentTime
  // (the deferred-seek effect above is the single owner of seek state).
  const stallRetry = useVideoStallRetry(inlineVideoRef, inlineVideoSrc || null);

  // Free the clip's bytes in the service worker's memory cache when the inline player closes
  // or moves to another clip. The per-seek remount keeps the same key, so it keeps the bytes.
  useScrubCacheLifetime(inlineVideoSrc || null);

  // Playback counts for the activity dashboard. The timeline's inline player is
  // a separate <video> from the grid player's, so it needs its own beacon.
  // `inlineVideo` is the bind token: it gets a new identity on every
  // click-to-seek, which is exactly when the <video> element is remounted and
  // the listeners have to be re-attached.
  usePlaybackBeacon(inlineVideoRef, inlineVideoSrc ? (inlineVideo?.event.id ?? null) : null, inlineVideo);

  // Frame-by-frame stepping for the inline player — mirrors the fullscreen
  // VideoPlayer. Walks the real VFR presentation-time grid when available,
  // falling back to the view's fixed fps inside stepOnGrid.
  const inlineStepFrame = useCallback((dir: 1 | -1) => {
    const v = inlineVideoRef.current;
    if (!v || !inlineVideo || !isFinite(v.duration)) return;
    v.pause();
    const viewRow = inlineVideo.event.views.find(vw => vw.id === inlineVideo.view);
    const fps = viewRow?.frameRate && viewRow.frameRate > 0 ? viewRow.frameRate : 0;
    v.currentTime = stepOnGrid(inlineFrameGrid, v.currentTime, dir, fps, v.duration);
  }, [inlineVideo, inlineFrameGrid]);

  // Drives the step buttons' disabled state — same guards + grid/fps as
  // inlineStepFrame so "disabled" means exactly "the step would be a no-op".
  const inlineCanStepFrame = useCallback((dir: 1 | -1) => {
    const v = inlineVideoRef.current;
    if (!v || !inlineVideo || !isFinite(v.duration)) return false;
    const viewRow = inlineVideo.event.views.find(vw => vw.id === inlineVideo.view);
    const fps = viewRow?.frameRate && viewRow.frameRate > 0 ? viewRow.frameRate : 0;
    return canStep(inlineFrameGrid, v.currentTime, dir, fps, v.duration);
  }, [inlineVideo, inlineFrameGrid]);

  // `,` / `.` step the inline player one frame back / forward — only while an
  // inline video is active. Guarded so the keys still type normally inside
  // inputs / textareas / contentEditable.
  useEffect(() => {
    if (!inlineVideo) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.contentEditable === 'true') return;
      if (e.key === ',') inlineStepFrame(-1);
      else if (e.key === '.') inlineStepFrame(1);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [inlineVideo, inlineStepFrame]);

  const isVideoLoading = !inlineLocked && (seekPending || videoBuffering || stallRetry.retrying || stallRetry.failed);

  // Hide the rapidly-changing % + byte detail for the first 5s of a load —
  // mirrors the iOS PlayerLoadingOverlay (spinner-only, details fade in after
  // detailsDelay). The numbers read as flicker, not progress, in the first
  // seconds. Armed by a setTimeout when loading begins, cleared when it ends
  // (and on unmount via the effect cleanup).
  const [showBufferDetails, setShowBufferDetails] = useState(false);
  useEffect(() => {
    if (!isVideoLoading) { setShowBufferDetails(false); return; }
    const id = setTimeout(() => setShowBufferDetails(true), 5000);
    return () => clearTimeout(id);
  }, [isVideoLoading]);

  const bufferLabel = stallRetry.failed
    ? t('timeline.failedToLoad')
    : stallRetry.retrying
      ? t('timeline.retrying', { count: stallRetry.retryCount, max: 10 })
      : seekPending
        ? 'Seeking to the selected position…'
        : 'Loading video…';

  // --- Resolve a click anywhere on the timeline (time legend, dead space,
  // nearby a bar) into either an in-place seek of the active player or a
  // new selection. Three cascading strategies, picked in priority order so
  // the user never sees a "click did nothing" outcome on a populated view:
  //   1. If a video is already playing AND the clicked wall-clock time falls
  //      inside that clip's duration, just scrub the active player.
  //   2. Otherwise pick one event per camera whose time range *contains*
  //      the click, walking cameras top-to-bottom — the first one becomes
  //      the new active player, started at the matching offset.
  //   3. Fallback: nearest event within visual-bar tolerance (legacy
  //      behavior for sparse timelines where the click landed in dead space).
  const handleTimelineTimeClick = useCallback((time: number) => {
    if (inlineVideo) {
      const evStart = new Date(inlineVideo.event.timestamp).getTime();
      const evDurMs = (inlineVideo.event.duration ?? EVENT_DURATION_MS / 1000) * 1000;
      if (time >= evStart && time < evStart + evDurMs) {
        const seekSec = (time - evStart) / 1000;
        setInlineVideo(prev => (prev ? { ...prev, seekSec } : prev));
        return;
      }
    }

    const intersecting: CameraEvent[] = [];
    for (const cam of cameraList) {
      const camEvents = eventsByCamera.get(cam) || [];
      for (const ev of camEvents) {
        const evStart = new Date(ev.timestamp).getTime();
        const evDurMs = (ev.duration ?? EVENT_DURATION_MS / 1000) * 1000;
        if (time >= evStart && time < evStart + evDurMs) {
          intersecting.push(ev);
          break;
        }
      }
    }
    if (intersecting.length > 0) {
      const first = intersecting[0];
      const seekSec = Math.max(0, (time - new Date(first.timestamp).getTime()) / 1000);
      const view = first.views[0]?.id;
      if (view) setInlineVideo({ event: first, view, seekSec });
      return;
    }

    const tolerance = Math.max(EVENT_DURATION_MS, visualBarDuration);
    const best = new Map<string, { ev: CameraEvent; dist: number }>();
    for (const ev of visibleEvents) {
      const dist = Math.abs(new Date(ev.timestamp).getTime() - time);
      if (dist > tolerance) continue;
      const existing = best.get(ev.camera);
      if (!existing || dist < existing.dist) {
        best.set(ev.camera, { ev, dist });
      }
    }
    const events = Array.from(best.values()).map(b => b.ev);
    if (events.length > 0) {
      const first = events[0];
      const view = first.views[0]?.id;
      if (view) setInlineVideo({ event: first, view });
    }
  }, [inlineVideo, cameraList, eventsByCamera, visibleEvents, visualBarDuration]);

  // Keep ref in sync so stable callbacks (handlePointerUp) always call the latest version
  useEffect(() => {
    handleTimeClickRef.current = handleTimelineTimeClick;
  }, [handleTimelineTimeClick]);

  // --- Event bar interactions ---
  const handleBarClick = useCallback((e: React.MouseEvent<SVGRectElement>, ev: CameraEvent) => {
    if (wasDragged.current) return;
    pendingClickTime.current = null; // cancel background click from handlePointerUp
    // Plain click → play from the start. ⌘-click (Mac) / Ctrl-click → precision
    // mode: seek proportionally to the bar's rendered width, using the event's
    // real duration (a mid-click on a 5 min clip lands at 2:30, not 0:15 as it
    // did when this was hardcoded to EVENT_DURATION_MS). Both modifiers work
    // on every platform, so a PC keyboard on a Mac (or vice versa) still works.
    const rect = e.currentTarget.getBoundingClientRect();
    const clipLenSec = ev.duration ?? EVENT_DURATION_MS / 1000;
    const seekSec = barClickSeekSec(e.clientX, rect.left, rect.width, clipLenSec, e.metaKey || e.ctrlKey);
    // A bar click never deselects — re-clicking the current event restarts it
    // (or re-seeks it in precision mode) instead of closing it.
    openBarAt(ev, seekSec);
  }, [openBarAt]);

  const handleBarDblClick = useCallback((ev: CameraEvent) => {
    const view = ev.views[0]?.id;
    if (view) handleInlinePlay(ev, view);
  }, [handleInlinePlay]);

  // --- Timeline background click (time legend, dead space) → seek/select ---
  // Bound to BOTH the rows SVG and the sticky ruler so clicking either scrubs
  // the playing clip. Uses currentTarget so the x-origin matches whichever band
  // was clicked (both are the same width = timelineWidth).
  const handleTimelineClick = useCallback((e: React.MouseEvent<Element>) => {
    if (wasDragged.current) return;
    // Bar clicks belong to handleBarClick. Bars are identified by their
    // data-event-id — not by cursor, which flips to crosshair in precision mode.
    const target = e.target;
    if (target instanceof Element && target.closest('rect[data-event-id]')) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const time = viewRef.current.viewStart +
      (mouseX / viewRef.current.timelineWidth) *
      (viewRef.current.viewEnd - viewRef.current.viewStart);
    handleTimelineTimeClick(time);
  }, [handleTimelineTimeClick]);

  // --- Player/timeline splitter drag (pointer-based, matches the file idiom) ---
  const onSplitterDown = useCallback((e: React.PointerEvent) => {
    splitDragRef.current = { startY: e.clientY, startH: timelineHeight };
    try { splitterRef.current?.setPointerCapture(e.pointerId); } catch { /* jsdom / detached */ }
    e.preventDefault();
  }, [timelineHeight]);
  const onSplitterMove = useCallback((e: React.PointerEvent) => {
    const d = splitDragRef.current;
    if (!d) return;
    const next = d.startH - (e.clientY - d.startY); // drag UP grows the timeline (shrinks the player)
    const avail = containerRef.current?.clientHeight ?? window.innerHeight;
    setTimelineHeight(Math.max(MIN_TIMELINE_H, Math.min(avail * MAX_TIMELINE_H_FRAC, next)));
  }, []);
  const onSplitterUp = useCallback((e: React.PointerEvent) => {
    splitDragRef.current = null;
    try { splitterRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
  }, []);

  // --- Hover tooltip + hover line (ref-based positioning — no re-renders per pixel) ---
  const handleMouseEnter = useCallback(() => setPointerOverTimeline(true), []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Resync the precision indicator from the live modifier state — covers a
    // ⌘/Ctrl pressed while the page didn't have focus (no keydown reached us).
    const held = e.metaKey || e.ctrlKey;
    setPrecisionHeld(prev => (prev === held ? prev : held));
    setPointerOverTimeline(true);
    if (isDragging.current) return;
    const rect = scrollRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const time = viewRef.current.viewStart +
      (mouseX / viewRef.current.timelineWidth) *
      (viewRef.current.viewEnd - viewRef.current.viewStart);

    // Resolve cursor Y to camera row. The rows SVG now starts at y=0 (the ruler
    // is a separate sticky band), and mouseY is relative to .timeline-scroll —
    // which scrolls with the rows — so no header offset is needed.
    const rowIdx = Math.floor(mouseY / ROW_HEIGHT);
    const camera = rowIdx >= 0 && rowIdx < cameraListRef.current.length
      ? cameraListRef.current[rowIdx]
      : null;
    setHoverCamera(prev => (prev === camera ? prev : camera));

    // Red hover line — positioned via DOM ref for 60fps smoothness
    const line = hoverLineRef.current;
    if (line) {
      line.setAttribute('x1', String(mouseX));
      line.setAttribute('x2', String(mouseX));
      line.style.display = '';
    }

    // Tooltip position via DOM ref — no state update, no re-render
    const tt = tooltipRef.current;
    if (tt) {
      const TOOLTIP_W = 240;
      let left = e.clientX + 14;
      let top = e.clientY - 14;
      if (left + TOOLTIP_W > window.innerWidth - 8) left = e.clientX - TOOLTIP_W - 14;
      if (top + 100 > window.innerHeight - 8) top = window.innerHeight - 108;
      if (top < 8) top = 8;
      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
      tt.style.display = 'block';
      const timeEl = tt.querySelector('.timeline-tooltip-time');
      if (timeEl) {
        timeEl.textContent = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
      }
    }
    hoverVisibleRef.current = true;

    // Only trigger React re-render when quantized time changes (for event list)
    const quantized = Math.round(time / HOVER_QUANTIZE_MS);
    setHoverTime(prev => {
      const prevQ = prev !== null ? Math.round(prev / HOVER_QUANTIZE_MS) : null;
      return prevQ === quantized ? prev : time;
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoverVisibleRef.current = false;
    const tt = tooltipRef.current;
    if (tt) tt.style.display = 'none';
    const line = hoverLineRef.current;
    if (line) line.style.display = 'none';
    setHoverTime(null);
    setHoverCamera(null);
    setPointerOverTimeline(false);
  }, []);

  const precisionActive = precisionHeld && pointerOverTimeline;
  const showPrecisionBadge = precisionActive || precisionFlash;

  // Events on the SAME camera that overlap in time with the one currently
  // playing — surfaces the "two recordings start ~10s apart on the same
  // camera, the bar on top hides the bar underneath" case. Sorted
  // ascending by timestamp so the chip list reads left-to-right
  // chronologically. Includes the current event itself so the chip set
  // doubles as a positional indicator (which one is active).
  const overlappingSiblings = useMemo(() => {
    if (!inlineVideo) return [] as CameraEvent[];
    const all = eventsByCamera.get(inlineVideo.event.camera) || [];
    const cur = inlineVideo.event;
    const curStart = new Date(cur.timestamp).getTime();
    const curEnd = curStart + (cur.duration ?? EVENT_DURATION_MS / 1000) * 1000;
    const out = all.filter(ev => {
      const evStart = new Date(ev.timestamp).getTime();
      const evEnd = evStart + (ev.duration ?? EVENT_DURATION_MS / 1000) * 1000;
      return evStart < curEnd && evEnd > curStart;
    });
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return out;
  }, [inlineVideo, eventsByCamera]);

  // --- Render ---
  return (
    <div className="timeline-container" ref={containerRef} data-testid="timeline" data-view-duration={viewDuration} data-view-start={viewStart}>
      {/* === Section 1: Inline video player (top, always visible) === */}
      <div className="timeline-section-player" data-testid="timeline-inline-player">
        {inlineVideo ? (
          <>
            <div className="timeline-inline-player-header">
              <span className="camera-badge" style={{ background: cameraColorMap.get(inlineVideo.event.camera) }}>
                {inlineVideo.event.camera}
              </span>
              {overlappingSiblings.length > 1 && (
                <div className="timeline-player-overlapping" data-testid="timeline-player-overlapping" title={t('player.overlapping')}>
                  {overlappingSiblings.map(ev => {
                    const isActive = ev.id === inlineVideo.event.id;
                    return (
                      <button
                        key={ev.id}
                        className={`timeline-overlapping-chip${isActive ? ' active' : ''}`}
                        disabled={isActive}
                        data-testid={`timeline-overlapping-chip-${ev.id}`}
                        title={formatEventDateTime(ev.timestamp)}
                        onClick={() => {
                          if (isActive) return;
                          // Carry the user's preferred view across the
                          // switch when the target event has the same
                          // view id; otherwise fall back to its primary.
                          const wantView = inlineVideo.view;
                          const l = ev.views.find(x => x.id === wantView)?.id ?? ev.views[0]?.id;
                          if (l) handleInlinePlay(ev, l);
                        }}
                      >
                        {formatEventTime(ev.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </button>
                    );
                  })}
                </div>
              )}
              <span className="timeline-player-header-details-inline timeline-detail-time">
                {formatEventDateTime(inlineVideo.event.timestamp)}
              </span>
              {/* View toggle. handleInlinePlay preserves currentTime when
                  the target is the same event with a different view —
                  exact same UX as the grid-view VideoPlayer. Renders one
                  button per attached view, so an N-view camera (3+) shows
                  N toggles. */}
              {inlineVideo.event.views.length >= 2 && (
                <div className="player-view-toggle">
                  {inlineVideo.event.views.map(l => (
                    <button
                      key={l.id}
                      className={`btn-view-toggle ${inlineVideo.view === l.id ? 'active' : ''}`}
                      onClick={() => handleInlinePlay(inlineVideo.event, l.id)}
                      title={l.label ? t(l.label) : l.id}
                      data-testid={`timeline-player-view-${l.id}`}
                    >
                      <ViewIcon kind={l.iconKind} size={16} />
                    </button>
                  ))}
                </div>
              )}
              {(() => {
                const currentRel = inlineVideo.event.views.find(l => l.id === inlineVideo.view)?.videoRelPath ?? null;
                return (
                  <>
                    <span className="timeline-player-header-details-inline timeline-inline-filename" title={getFilename(currentRel)}>
                      {getFilename(currentRel)}
                    </span>
                    <a href="#" onClick={(e) => { e.preventDefault(); if (currentRel) api.downloadVideo(inlineVideo.event.id, inlineVideo.view, getFilename(currentRel)); }}
                      className="btn-download timeline-player-download" title={t('player.download')}
                      data-testid="timeline-player-download">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </a>
                  </>
                );
              })()}
              <button className="timeline-player-hamburger" onClick={() => setPlayerMenuOpen(v => !v)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
              </button>
              {playerMenuOpen && (() => {
                const currentRel = inlineVideo.event.views.find(l => l.id === inlineVideo.view)?.videoRelPath ?? null;
                return (
                <div className="timeline-player-dropdown">
                  <div className="timeline-player-dropdown-item">
                    {formatEventDateTime(inlineVideo.event.timestamp)}
                  </div>
                  <div className="timeline-player-dropdown-item timeline-player-dropdown-filename">
                    {getFilename(currentRel)}
                  </div>
                  <a href="#" onClick={(e) => { e.preventDefault(); setPlayerMenuOpen(false); if (currentRel) api.downloadVideo(inlineVideo.event.id, inlineVideo.view, getFilename(currentRel)); }}
                    className="timeline-player-dropdown-item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    {t('player.download')}
                  </a>
                </div>
                );
              })()}
            </div>
            {inlineVideoSrc ? (
              (() => {
                const seekSec = inlineVideo.seekSec ?? 0;
                // We deliberately do NOT use the #t=N media fragment and
                // we don't seek inside onLoadedMetadata directly — both
                // strategies died on Reolink clips whose MP4 header
                // reports a wrong (short) duration (5 s for a 2:05 clip).
                // Instead the deferred-seek effect below arms the seek
                // and retries on every `durationchange` event, giving
                // progressive playback a chance to discover the real
                // duration and land the seek when it finally fits.
                return (
                  <div className="timeline-inline-video-wrap" ref={inlineWrapRef}>
                    {/* key on VideoZoom (not just the <video>) so the whole
                        zoom surface remounts per clip — that resets any
                        active zoom for free, matching the grid player which
                        instead resets imperatively. */}
                    <VideoZoom
                      key={`${inlineVideo.event.id}-${inlineVideo.view}-${seekSec}`}
                      onStep={inlineStepFrame}
                      videoRef={inlineVideoRef}
                      canStep={inlineCanStepFrame}
                    >
                      <video
                        ref={inlineVideoRef}
                        // metadata, not auto: the browser used to proactively
                        // fetch the entire file even when the user only
                        // hovered over the timeline. With faststart sidecars
                        // serving the player, the moov atom now sits at the
                        // file head so "metadata" is enough to start
                        // decoding without the dreaded tail-fetch first.
                        preload="metadata"
                        autoPlay
                        playsInline
                        className="timeline-inline-video"
                        data-testid="timeline-inline-video"
                        data-seek-sec={seekSec}
                        data-event-id={inlineVideo?.event.id ?? ''}
                      />
                    </VideoZoom>
                    <BlurredThumbnailBackdrop eventId={inlineVideo.event.id} visible={isVideoLoading} />
                    {isVideoLoading && (
                      <div className="timeline-inline-video-buffer-overlay"
                           data-testid="timeline-inline-video-buffer">
                        {!stallRetry.failed && <div className="spinner" />}
                        <div className="timeline-inline-video-buffer-label"
                             data-testid="timeline-inline-video-buffer-label">
                          {bufferLabel}
                        </div>
                        {showBufferDetails && bufferedSec !== null && !stallRetry.failed && !stallRetry.retrying && (() => {
                          const overlay = computeBufferOverlay({
                            bufferedSec: bufferedSec ?? 0,
                            durationSec: videoDurationSec,
                            directTotalBytes: videoTotalBytes,
                            hlsLoadedBytes: null,
                          });
                          if (overlay.downloadedBytes === null || overlay.startupBytes === null) {
                            return (
                              <div className="buffer-pct">
                                {overlay.pct}%
                                {overlay.downloadedBytes !== null && (
                                  <span className="buffer-mb"> · {fmtMB(overlay.downloadedBytes)}</span>
                                )}
                              </div>
                            );
                          }
                          return (
                            <div className="buffer-pct">
                              {overlay.pct}%
                              <span className="buffer-mb"> · {t('timeline.bufferProgress', {
                                downloaded: fmtMB(overlay.downloadedBytes),
                                needed: fmtMB(overlay.startupBytes),
                              })}</span>
                            </div>
                          );
                        })()}
                        {stallRetry.failed && (
                          <div className="video-buffer-actions"
                               data-testid="timeline-inline-video-buffer-actions">
                            <button
                              className="btn btn-sm"
                              onClick={() => stallRetry.manualRetry()}
                              data-testid="timeline-inline-video-buffer-retry"
                            >
                              {t('timeline.retryNow')}
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={() => { stallRetry.cancel(); setInlineVideo(null); }}
                              data-testid="timeline-inline-video-buffer-cancel"
                            >
                              {t('timeline.cancel')}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <VideoControls
                      videoRef={inlineVideoRef}
                      containerRef={inlineWrapRef}
                      mediaKey={`${inlineVideo.event.id}-${inlineVideo.view}-${seekSec}`}
                      visible={!isVideoLoading}
                    />
                  </div>
                );
              })()
            ) : (
              <div className="timeline-inline-video" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {inlineLocked
                  ? <span data-testid="timeline-inline-locked" style={{ color: '#fff', fontWeight: 500 }}>{t('account.lockedPlayback')}</span>
                  : <span>Loading...</span>}
              </div>
            )}
          </>
        ) : (
          <div className="timeline-player-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
              <polygon points="5 3 19 12 5 21"/>
            </svg>
            <span>{t('timeline.selectToPlay')}</span>
          </div>
        )}
      </div>

      {/* Section 2 (the per-event cards strip with thumbnails + view
          toggles + favorite/tag controls) was retired \u2014 those controls
          now live in the inline player header above, mirroring the
          grid-view VideoPlayer.tsx layout so the two views feel the same. */}

      {/* Draggable divider — drag up to enlarge the timeline, down to enlarge the player. */}
      <div className="timeline-splitter" ref={splitterRef}
        onPointerDown={onSplitterDown} onPointerMove={onSplitterMove}
        onPointerUp={onSplitterUp} onPointerCancel={onSplitterUp}
        role="separator" aria-orientation="horizontal" data-testid="timeline-splitter" />

      {/* === Section 3: Timeline (bottom, pinned to bottom edge) === */}
      <div className="timeline-section-bottom" style={{ height: timelineHeight }}>
        <div className="timeline-nav">
          <span className="timeline-date-label">{dateRangeLabel}</span>
          <div className="timeline-nav-actions">
            <div className="timeline-datepicker-anchor">
              <button className="btn btn-sm timeline-datepicker-trigger"
                onClick={() => setDatePickerOpen(o => !o)}
                title={t('timeline.pickDate')}
                data-testid="timeline-datepicker-trigger">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </button>
              {datePickerOpen && (
                <TimelineDatePicker
                  selectedDate={new Date((viewStart + viewEnd) / 2)}
                  onSelect={handlePickDate}
                  onClose={() => setDatePickerOpen(false)}
                />
              )}
            </div>
            <div className="timeline-camfilter-anchor" ref={camFilterRef}>
              <button className="btn btn-sm" onClick={() => setCamFilterOpen(o => !o)}
                title={t('timeline.cameraFilterTitle')} data-testid="timeline-camfilter-trigger">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                {t('timeline.cameraFilter', { shown: shownCamCount, total: allKnownCameras.length })}
              </button>
              {camFilterOpen && (
                <div className="timeline-camfilter-popover" data-testid="timeline-camfilter-popover">
                  <CameraChecklist
                    cameras={allKnownCameras}
                    isChecked={(c) => !hiddenCameras.has(c)}
                    onToggle={(c) => setHiddenCameras(prev => {
                      const next = new Set(prev);
                      if (next.has(c)) next.delete(c); else next.add(c);
                      return next;
                    })}
                    onSelectAll={() => setHiddenCameras(new Set())}
                    onSelectNone={() => setHiddenCameras(new Set(allKnownCameras))}
                    colorMap={cameraColorMap}
                    testIdPrefix="timeline-camfilter"
                  />
                </div>
              )}
            </div>
            <button className="btn btn-sm" onClick={handleZoomIn} title={t('player.zoomIn')} data-testid="timeline-zoom-in">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            </button>
            <button className="btn btn-sm" onClick={handleZoomOut} title={t('player.zoomOut')} data-testid="timeline-zoom-out">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            </button>
            {showPrecisionBadge && (
              <span className="timeline-precision-badge" data-testid="timeline-precision-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="23"/><line x1="1" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="23" y2="12"/>
                </svg>
                {t('timeline.precisionMode')}
              </span>
            )}
          </div>
        </div>
        <div className="timeline-body" data-testid="timeline-body" style={{ position: 'relative' }}>
          {/* Overlays — .timeline-scroll is always mounted so ResizeObserver + wheel listener work */}
          {loading && visibleEvents.length === 0 && (
            <div className="timeline-loading-overlay">
              <div className="spinner" />
            </div>
          )}
          {cameraList.length === 0 && !loading && (
            <div className="timeline-loading-overlay">
              <span className="timeline-empty" style={{ padding: 0 }}>{t('timeline.noEvents')}</span>
            </div>
          )}

          {/* Sticky time-axis ruler — stays pinned while the camera rows scroll. */}
          <div className="timeline-ruler">
            <div className="timeline-sidebar-header" />
            <div className="timeline-ruler-scroll" ref={headerScrollRef} onClick={handleTimelineClick} data-testid="timeline-ruler">
              <svg width={timelineWidth} height={HEADER_HEIGHT}>
                {dayBoundaries.map(db => (
                  <text key={`dl-${db.time}`} x={timeToX(db.time) + 4} y={12}
                    fill="var(--text2)" fontSize={10} fontFamily="inherit" opacity={0.7}>
                    {db.label}
                  </text>
                ))}
                {ticks.map(tick => {
                  const x = timeToX(tick.time);
                  return (
                    <g key={tick.time}>
                      <line x1={x} y1={HEADER_HEIGHT - 5} x2={x} y2={HEADER_HEIGHT}
                        stroke="var(--border)" strokeWidth={tick.isMajor ? 1 : 0.5} />
                      <text x={x} y={HEADER_HEIGHT - 9} textAnchor="middle"
                        fill="var(--text2)" fontSize={11} fontFamily="inherit">
                        {tick.label}
                      </text>
                    </g>
                  );
                })}
                {/* Buffer "still loading" dot lives in the ruler so it stays
                    visible no matter how far the rows are scrolled. */}
                {inlineVideo && isVideoLoading && (() => {
                  const baseTs = new Date(inlineVideo.event.timestamp).getTime();
                  const x = timeToX(baseTs + (inlineVideo.seekSec ?? 0) * 1000);
                  return (
                    <circle ref={playheadBufferDotRef} className="timeline-playhead-buffer"
                      cx={x} cy={HEADER_HEIGHT / 2} r={4}
                      data-testid="timeline-playhead-buffer" style={{ pointerEvents: 'none' }} />
                  );
                })()}
              </svg>
            </div>
          </div>

          {/* Camera rows — the vertical scroller. Sidebar labels + the rows SVG
              are siblings of equal height so they scroll in lockstep. */}
          <div className="timeline-scroll-row" ref={vScrollRef}>
            <div className="timeline-sidebar" style={{ height: rowsHeight }}>
              {cameraList.map(cam => (
                <div key={cam} className="timeline-label" style={{ height: dynamicRowHeight }} data-testid={`timeline-cam-${cam}`}>
                  <span className="timeline-camera-dot" style={{ background: cameraColorMap.get(cam) }} />
                  <span className="timeline-cam-name">{cam}</span>
                </div>
              ))}
            </div>

          <div
            className="timeline-scroll"
            ref={scrollRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={handleContextMenu}
            onMouseEnter={handleMouseEnter}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{ cursor: cursorGrabbing ? 'grabbing' : 'grab' }}
            data-testid="timeline-scroll"
          >
            <svg width={timelineWidth} height={rowsHeight} onClick={handleTimelineClick}>
              {/* Row backgrounds */}
              {cameraList.map((_, i) => (
                <rect key={`bg-${i}`} x={0} y={i * dynamicRowHeight}
                  width={timelineWidth} height={dynamicRowHeight}
                  fill={i % 2 === 0 ? 'transparent' : 'var(--bg2)'} />
              ))}

              {/* Day boundary lines — neutral gridline (matches the iOS
                  midnight marker); the date label in the sticky ruler is what
                  flags the new day. Labels are drawn in the sticky ruler. */}
              {dayBoundaries.map(db => {
                const x = timeToX(db.time);
                return (
                  <line key={`day-${db.time}`} x1={x} y1={0} x2={x} y2={rowsHeight}
                    stroke="var(--border)" strokeWidth={1} opacity={0.9} />
                );
              })}

              {/* Time tick lines (labels are drawn in the sticky ruler) */}
              {ticks.map(tick => {
                const x = timeToX(tick.time);
                return (
                  <line key={tick.time} x1={x} y1={0} x2={x} y2={rowsHeight}
                    stroke="var(--border)" strokeWidth={tick.isMajor ? 1 : 0.5} />
                );
              })}

              {/* Row dividers */}
              {cameraList.map((_, i) => (
                <line key={`d-${i}`}
                  x1={0} y1={(i + 1) * dynamicRowHeight}
                  x2={timelineWidth} y2={(i + 1) * dynamicRowHeight}
                  stroke="var(--border)" strokeWidth={0.5} />
              ))}

              {/* Event bars */}
              {cameraList.map((cam, row) => {
                const camEvents = eventsByCamera.get(cam) || [];
                return camEvents.map(ev => {
                  const evTime = new Date(ev.timestamp).getTime();
                  const x = timeToX(evTime);
                  // Real video duration when known (set by thumbnail-worker via
                  // ffmpeg probe); fall back to EVENT_DURATION_MS for events
                  // whose duration isn't backfilled yet. Without this the bar
                  // stayed 30s wide regardless of the clip — playhead exited
                  // the rect by ~20% into a long clip and clicking inside the
                  // bar always seeked into the first 30s instead of the clip.
                  const evDurationMs = (ev.duration ?? EVENT_DURATION_MS / 1000) * 1000;
                  let w = (evDurationMs / viewDuration) * timelineWidth;
                  if (w < MIN_BAR_WIDTH) w = MIN_BAR_WIDTH;
                  const barCullMargin = Math.max(CULL_MARGIN, w);
                  if (x + w < -barCullMargin || x > timelineWidth + barCullMargin) return null;

                  const y = row * dynamicRowHeight + 8;
                  const h = dynamicRowHeight - 16;
                  // Active = the event the inline player is currently
                  // playing. Bumped opacity + white outline make it stand
                  // out against neighbouring bars in the same row.
                  const isActive = inlineVideo?.event.id === ev.id;

                  return (
                    <rect key={ev.id} x={x} y={y} width={w} height={h} rx={3}
                      // Map is built from the same `cameraList` we
                      // iterate, so the lookup always hits. The
                      // fallback string is just a defensive grey for
                      // the impossible "stale event references a
                      // camera that just got renamed" race.
                      fill={cameraColorMap.get(cam) ?? 'hsl(0deg 0% 55%)'}
                      opacity={isActive ? 1 : 0.8}
                      stroke={isActive ? '#fff' : 'none'} strokeWidth={isActive ? 2 : 0}
                      style={{ cursor: precisionActive ? 'crosshair' : 'pointer' }}
                      data-testid={`timeline-bar-${ev.id}`}
                      data-event-id={ev.id}
                      onClick={(e) => handleBarClick(e, ev)}
                      onDoubleClick={() => handleBarDblClick(ev)}
                    >
                      <title>{cam} — {formatEventTime(ev.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</title>
                    </rect>
                  );
                });
              })}

              {/* Now line — dashed wall-clock indicator in green (--success is
                  green in both themes; --accent goes blue in light mode), kept
                  visually distinct from the red playhead. Matches iOS. */}
              {showNow && (
                <line x1={timeToX(now)} y1={0} x2={timeToX(now)} y2={rowsHeight}
                  stroke="var(--success)" strokeWidth={1.5} strokeDasharray="4,3" data-testid="timeline-now" />
              )}

              {/* Hover line — ref-based positioning for 60fps. Full opacity in
                  precision mode: it marks exactly where a ⌘/Ctrl-click lands. */}
              <line ref={hoverLineRef} y1={0} y2={rowsHeight} x1={0} x2={0}
                stroke="var(--danger)" strokeWidth={1} opacity={precisionActive ? 1 : 0.5}
                style={{ display: 'none', pointerEvents: 'none' }}
                data-testid="timeline-hover-line" />

              {/* Playhead — rendered LAST so it's on top. Position is driven by
                  the inline video's currentTime via a rAF loop (updatePlayhead),
                  so it tracks playback smoothly. The JSX initial x1/x2 honors
                  the requested seekSec so the line doesn't flash to the event
                  start before the video element finishes loading metadata. */}
              {inlineVideo && (() => {
                const baseTs = new Date(inlineVideo.event.timestamp).getTime();
                const seekMs = (inlineVideo.seekSec ?? 0) * 1000;
                const x = timeToX(baseTs + seekMs);
                return (
                  <line ref={playheadRef} y1={0} y2={rowsHeight} x1={x} x2={x}
                    stroke="var(--danger)" strokeWidth={2} opacity={0.9}
                    data-testid="timeline-playhead"
                    style={{ pointerEvents: 'none' }} />
                );
              })()}
            </svg>
          </div>
          </div>{/* end timeline-scroll-row */}
        </div>
      </div>{/* end timeline-section-bottom */}

      {/* Hover tooltip — ref-based positioning, React only re-renders for event list changes */}
      <div className="timeline-tooltip" ref={tooltipRef} style={{ display: 'none' }} data-testid="timeline-tooltip">
        <div className="timeline-tooltip-time" />
        {hoverEvents.length > 0 && (
          <div className="timeline-tooltip-thumbs">
            {hoverEvents.map(ev => (
              <div key={ev.id} className="timeline-tooltip-thumb">
                <AuthImage eventId={ev.id} alt="" />
                <span>{ev.camera}</span>
              </div>
            ))}
          </div>
        )}
        {/* Discoverability for precision mode — mouse/trackpad only (the
            tooltip is hidden on hover-less devices anyway), and only when a
            bar is under the cursor, since the hint is about clicking one. */}
        {finePointer && hoverEvents.length > 0 && (
          <div className="timeline-tooltip-hint" data-testid="timeline-tooltip-hint">
            {t('timeline.precisionHint', { key: isMac ? '⌘' : 'Ctrl' })}
          </div>
        )}
      </div>

    </div>
  );
}
