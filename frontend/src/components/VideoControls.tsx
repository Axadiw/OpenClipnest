import { useEffect, useMemo, useRef, useState, useCallback, type RefObject } from 'react';
import { useTranslation } from '../i18n';
import { formatClock, clamp01, pointerFraction, bufferedSegments, mergeSegments, type Segment } from '../lib/videoControls';
import { useScrubPreview } from '../hooks/useScrubPreview';
import { subscribeCachedRanges } from '../lib/scrubCache/client';
import { cachedFractionSegments, usableCachedRanges } from '../lib/scrubPreview/cachedSegments';
import { videoCacheKey } from '../sw/videoRequest';
import { ScrubPreviewBubble } from './ScrubPreviewBubble';

const SPEEDS = [0.5, 1, 1.5, 2];
const LS_VOLUME = 'clipnest.player.volume';
const LS_MUTED = 'clipnest.player.muted';
const HIDE_DELAY_MS = 2500;

interface VideoControlsProps {
  /** The <video> element to drive. The parent owns its src/load/seek logic. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Fullscreen target — the player container, so our bar stays visible in fullscreen. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Bumped by the parent whenever the underlying <video> element or source
   * changes (e.g. the Timeline player remounts its <video> on every seek via
   * a `key`). Re-binds listeners + re-reads state onto the new element.
   */
  mediaKey?: string | number;
  /** Hide the bar (e.g. while the parent's initial-load overlay is up). */
  visible?: boolean;
  /**
   * Notified whenever the bar's effective visibility changes (auto-hide while
   * playing, or the `visible` gate). Lets the parent fade sibling overlays —
   * the zoom / frame-step controls — in lockstep with the bar, so they don't
   * linger on screen after the bar has auto-hidden (notably in fullscreen).
   */
  onChromeVisibleChange?: (visible: boolean) => void;
}

/**
 * Custom <video> control bar shared by the grid player (VideoPlayer) and the
 * timeline inline player. Replaces the browser-native controls — whose
 * scrubber colour can't be themed from CSS in Chrome/Firefox/Safari — with a
 * green (var(--success)) scrubber matching the iOS app. Drives the element
 * through the passed-in ref; it never owns the element or its source.
 */
export function VideoControls({ videoRef, containerRef, mediaKey, visible = true, onChromeVisibleChange }: VideoControlsProps) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<Segment[]>([]);
  const [cachedRanges, setCachedRanges] = useState<{ total: number; ranges: { start: number; end: number }[] }>({ total: 0, ranges: [] });
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [isPiP, setIsPiP] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [barShown, setBarShown] = useState(true);

  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const preview = useScrubPreview(videoRef, mediaKey);
  const { show: showPreview, hide: hidePreview } = preview;
  /** Detaches the window listeners of a drag in progress (mouse live-seek or touch preview). */
  const endDragRef = useRef<(() => void) | null>(null);
  const touchDragRef = useRef(false);
  const previewShownRef = useRef(false);

  // Sync local state from the media element + restore persisted audio prefs.
  // Re-runs when the element identity changes (mediaKey) so the Timeline
  // player's per-seek <video> remount keeps the bar bound to the live element.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const savedVol = parseFloat(localStorage.getItem(LS_VOLUME) ?? '');
    if (Number.isFinite(savedVol)) v.volume = clamp01(savedVol);
    const savedMuted = localStorage.getItem(LS_MUTED);
    if (savedMuted !== null) v.muted = savedMuted === 'true';

    const syncPlay = () => setPlaying(!v.paused);
    const syncTime = () => setCurrent(v.currentTime);
    const syncDuration = () => setDuration(Number.isFinite(v.duration) ? v.duration : 0);
    const syncBuffered = () => setBuffered(bufferedSegments(v.buffered, v.duration));
    const syncVolume = () => { setVolume(v.volume); setMuted(v.muted); };
    const syncRate = () => setRate(v.playbackRate);
    const onWaiting = () => setBuffering(true);
    const onResume = () => setBuffering(false);
    const onEnterPiP = () => setIsPiP(true);
    const onLeavePiP = () => setIsPiP(false);

    syncPlay(); syncTime(); syncDuration(); syncBuffered(); syncVolume(); syncRate();
    setBuffering(false);

    v.addEventListener('play', syncPlay);
    v.addEventListener('pause', syncPlay);
    v.addEventListener('pause', onResume);
    v.addEventListener('timeupdate', syncTime);
    v.addEventListener('timeupdate', syncBuffered);
    v.addEventListener('durationchange', syncDuration);
    v.addEventListener('loadedmetadata', syncDuration);
    v.addEventListener('progress', syncBuffered);
    v.addEventListener('volumechange', syncVolume);
    v.addEventListener('ratechange', syncRate);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onResume);
    v.addEventListener('canplay', onResume);
    v.addEventListener('seeked', onResume);
    v.addEventListener('enterpictureinpicture', onEnterPiP);
    v.addEventListener('leavepictureinpicture', onLeavePiP);
    return () => {
      v.removeEventListener('play', syncPlay);
      v.removeEventListener('pause', syncPlay);
      v.removeEventListener('pause', onResume);
      v.removeEventListener('timeupdate', syncTime);
      v.removeEventListener('timeupdate', syncBuffered);
      v.removeEventListener('durationchange', syncDuration);
      v.removeEventListener('loadedmetadata', syncDuration);
      v.removeEventListener('progress', syncBuffered);
      v.removeEventListener('volumechange', syncVolume);
      v.removeEventListener('ratechange', syncRate);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onResume);
      v.removeEventListener('canplay', onResume);
      v.removeEventListener('seeked', onResume);
      v.removeEventListener('enterpictureinpicture', onEnterPiP);
      v.removeEventListener('leavepictureinpicture', onLeavePiP);
    };
  }, [videoRef, mediaKey]);

  // Ranges the service worker holds for this recording (also those only the hover preview
  // fetched). The worker announces changes at most 4x a second and answers a query on subscribe,
  // so a freshly mounted player already sees what an earlier page session cached.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let unsubscribe: (() => void) | null = null;
    let boundSrc = '';
    const bind = () => {
      const src = v.currentSrc || v.src;
      // The token changes on refresh while the recording stays the same: keep the subscription.
      const id = src ? videoCacheKey(src) ?? src.split('?')[0] : '';
      if (!id || id === boundSrc) return;
      boundSrc = id;
      unsubscribe?.();
      setCachedRanges({ total: 0, ranges: [] });
      unsubscribe = subscribeCachedRanges(src, (r) => setCachedRanges({ total: r.total, ranges: r.ranges }));
    };
    bind();
    v.addEventListener('loadstart', bind);
    v.addEventListener('loadedmetadata', bind);
    return () => {
      v.removeEventListener('loadstart', bind);
      v.removeEventListener('loadedmetadata', bind);
      unsubscribe?.();
    };
  }, [videoRef, mediaKey]);

  // The index walk depends only on the worker's ranges (announced at most 4x a second), not on
  // the element's own `buffered`, which gets a new array on every timeupdate.
  const cachedSegments = useMemo(
    () => cachedFractionSegments(
      preview.sampleIndex,
      usableCachedRanges(cachedRanges.ranges, cachedRanges.total, preview.sampleTotal),
      duration,
    ),
    [preview.sampleIndex, preview.sampleTotal, cachedRanges, duration],
  );
  const greySegments = useMemo(() => mergeSegments([...buffered, ...cachedSegments]), [buffered, cachedSegments]);

  // Track fullscreen state from the document (covers Esc / browser-driven exit).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [containerRef]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { const p = v.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
    else v.pause();
  }, [videoRef]);

  // Click on the video itself toggles play/pause, matching native controls.
  // A double-click (the grid player's zoom-reset) fires two clicks → two
  // toggles → net-neutral, so the play state is preserved while the zoom
  // resets. Clicks on the control bar land on the bar (a sibling overlay),
  // not the <video>, so they don't reach this handler.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onClick = () => togglePlay();
    v.addEventListener('click', onClick);
    return () => v.removeEventListener('click', onClick);
  }, [videoRef, mediaKey, togglePlay]);

  const seekTo = useCallback((frac: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = clamp01(frac) * v.duration;
    setCurrent(v.currentTime);
  }, [videoRef]);

  const seekFromClientX = useCallback((clientX: number) => {
    const track = seekRef.current;
    if (!track) return;
    seekTo(pointerFraction(clientX, track.getBoundingClientRect()));
  }, [seekTo]);

  // Auto-hide the bar after inactivity while playing; always shown when paused. Never while the
  // preview bubble is up or a finger is dragging the knob: the pointer rests exactly while the
  // user reads the frame, and a hidden bar would leave the drag running invisibly.
  const revealBar = useCallback(() => {
    setBarShown(true);
    if (hideTimerRef.current) { window.clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (previewShownRef.current || touchDragRef.current) return;
    if (!videoRef.current?.paused) {
      hideTimerRef.current = window.setTimeout(() => setBarShown(false), HIDE_DELAY_MS);
    }
  }, [videoRef]);

  // Hold the bar while the bubble is shown; re-arm the auto-hide when it goes away.
  const previewShown = preview.state !== 'hidden';
  useEffect(() => {
    const was = previewShownRef.current;
    previewShownRef.current = previewShown;
    if (previewShown || was) revealBar();
  }, [previewShown, revealBar]);

  const fractionAt = useCallback((clientX: number): number | null => {
    const track = seekRef.current;
    return track ? pointerFraction(clientX, track.getBoundingClientRect()) : null;
  }, []);

  // Mouse / pen: press seeks live and dragging keeps seeking (the preview bubble is for hovering).
  // Touch: the finger has no hover, so pressing and dragging only moves the preview bubble and
  // playback carries on; lifting the finger seeks there, and a cancelled gesture seeks nowhere.
  const onSeekPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    endDragRef.current?.();
    const touch = e.pointerType === 'touch';
    let last = fractionAt(e.clientX);
    if (touch) {
      touchDragRef.current = true;
      revealBar();
      if (last !== null) showPreview(last);
    } else {
      hidePreview();
      draggingRef.current = true;
      seekFromClientX(e.clientX);
    }
    const move = (ev: PointerEvent) => {
      if (touch) {
        const f = fractionAt(ev.clientX);
        if (f !== null) { last = f; showPreview(f); }
      } else if (draggingRef.current) {
        seekFromClientX(ev.clientX);
      }
    };
    const end = () => {
      draggingRef.current = false;
      touchDragRef.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (endDragRef.current === end) endDragRef.current = null;
    };
    const up = () => {
      end();
      if (touch) {
        if (last !== null) seekTo(last);
        hidePreview();
        revealBar();
      }
    };
    const cancel = () => {
      end();
      if (touch) { hidePreview(); revealBar(); }
    };
    endDragRef.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, [fractionAt, seekFromClientX, seekTo, showPreview, hidePreview, revealBar]);

  const onSeekPointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch' || e.buttons !== 0) return;
    const f = fractionAt(e.clientX);
    if (f !== null) showPreview(f);
  }, [fractionAt, showPreview]);

  const onSeekPointerLeave = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return; // a finger sliding off the bar keeps dragging
    hidePreview();
  }, [hidePreview]);

  useEffect(() => () => endDragRef.current?.(), []);

  const onSeekKeyDown = useCallback((e: React.KeyboardEvent) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(1); }
  }, [videoRef, seekTo]);

  const applyVolume = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = clamp01(val);
    v.volume = clamped;
    v.muted = clamped === 0;
    localStorage.setItem(LS_VOLUME, String(clamped));
    localStorage.setItem(LS_MUTED, String(v.muted));
    setVolume(clamped);
    setMuted(v.muted);
  }, [videoRef]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    localStorage.setItem(LS_MUTED, String(v.muted));
    setMuted(v.muted);
  }, [videoRef]);

  const setSpeed = useCallback((s: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = s;
    setRate(s);
    setSpeedOpen(false);
  }, [videoRef]);

  const togglePiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { /* user gesture / unsupported — ignore */ }
  }, [videoRef]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch { /* ignore */ }
  }, [containerRef]);

  // Keyboard shortcuts: Space (play/pause), F (fullscreen), M (mute). Left/Right
  // stay on prev/next-event and ,/. on frame-step (owned by the parents).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt.isContentEditable)) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
      else if (e.key === 'm' || e.key === 'M') { toggleMute(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [togglePlay, toggleFullscreen, toggleMute]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = () => revealBar();
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerenter', onMove);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerenter', onMove);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [containerRef, revealBar]);

  // Always show the bar while paused.
  useEffect(() => { if (!playing) setBarShown(true); }, [playing]);

  // Single source of truth for chrome visibility. `barShown` is the auto-hide
  // timer state; `visible` is the parent's load-overlay gate. The parent uses
  // this to fade the sibling zoom / frame-step controls in lockstep.
  const chromeVisible = barShown && visible;
  useEffect(() => { onChromeVisibleChange?.(chromeVisible); }, [chromeVisible, onChromeVisibleChange]);

  const playedFrac = duration > 0 ? clamp01(current / duration) : 0;
  const playedPct = `${(playedFrac * 100).toFixed(2)}%`;
  const pipSupported = typeof document !== 'undefined' && (document as Document).pictureInPictureEnabled;

  return (
    <div
      className={`video-controls${chromeVisible ? '' : ' video-controls-hidden'}`}
      data-testid="player-controls"
      onPointerMove={revealBar}
    >
      <button
        className="video-controls-btn"
        data-testid="player-playpause"
        aria-label={playing ? t('player.pause') : t('player.play')}
        title={playing ? t('player.pause') : t('player.play')}
        onClick={togglePlay}
      >
        {buffering && <span className="video-controls-spinner" data-testid="player-buffering" aria-hidden="true" />}
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg>
        )}
      </button>

      <span className="video-controls-time" data-testid="player-time">
        {formatClock(current)} / {formatClock(duration)}
      </span>

      <div
        ref={seekRef}
        className="video-controls-seek"
        data-testid="player-seek"
        role="slider"
        tabIndex={0}
        aria-label={t('player.seek')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        onPointerDown={onSeekPointerDown}
        onPointerMove={onSeekPointerMove}
        onPointerLeave={onSeekPointerLeave}
        onKeyDown={onSeekKeyDown}
      >
        <div className="video-controls-seek-track" />
        {greySegments.map((seg, i) => (
          <div
            key={i}
            className="video-controls-seek-buffered"
            data-testid="player-seek-buffered"
            style={{ left: `${(seg.start * 100).toFixed(2)}%`, width: `${((seg.end - seg.start) * 100).toFixed(2)}%` }}
          />
        ))}
        <div className="video-controls-seek-played" style={{ width: playedPct }} />
        <div className="video-controls-seek-thumb" style={{ left: playedPct }} />
        <ScrubPreviewBubble state={preview.state} time={preview.time} fraction={preview.fraction} canvasRef={preview.canvasRef} />
      </div>

      <button
        className="video-controls-btn"
        data-testid="player-mute"
        aria-label={muted ? t('player.unmute') : t('player.mute')}
        title={muted ? t('player.unmute') : t('player.mute')}
        onClick={toggleMute}
      >
        {muted ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="3 9 7 9 12 4 12 20 7 15 3 15 3 9" fill="currentColor" stroke="none"/><line x1="16" y1="9" x2="22" y2="15"/><line x1="22" y1="9" x2="16" y2="15"/></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="3 9 7 9 12 4 12 20 7 15 3 15 3 9" fill="currentColor" stroke="none"/><path d="M16 8a5 5 0 0 1 0 8"/></svg>
        )}
      </button>

      <input
        type="range"
        className="video-controls-volume"
        data-testid="player-volume"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        aria-label={t('player.volume')}
        onChange={(e) => applyVolume(parseFloat(e.target.value))}
      />

      <div className="video-controls-speed-wrap">
        <button
          className="video-controls-btn video-controls-speed"
          data-testid="player-speed"
          aria-label={t('player.speed')}
          title={t('player.speed')}
          aria-expanded={speedOpen}
          onClick={() => setSpeedOpen(o => !o)}
        >
          {rate}×
        </button>
        {speedOpen && (
          <div className="video-controls-speed-menu" role="menu">
            {SPEEDS.map(s => (
              <button
                key={s}
                role="menuitemradio"
                aria-checked={rate === s}
                className={`video-controls-speed-item${rate === s ? ' active' : ''}`}
                data-testid={`player-speed-${s}`}
                onClick={() => setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
      </div>

      {pipSupported && (
        <button
          className="video-controls-btn"
          data-testid="player-pip"
          aria-label={t('player.pip')}
          title={t('player.pip')}
          aria-pressed={isPiP}
          onClick={togglePiP}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/></svg>
        </button>
      )}

      <button
        className="video-controls-btn"
        data-testid="player-fullscreen"
        aria-label={t('player.fullscreen')}
        title={t('player.fullscreen')}
        aria-pressed={isFullscreen}
        onClick={toggleFullscreen}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
    </div>
  );
}
