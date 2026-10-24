import { useEffect, useRef, useState, useCallback } from 'react';
import { api, ApiError } from '../api';
import { useTranslation } from '../i18n';
import { getFilename, type CameraEvent, type ViewId } from '../types';
import { ViewIcon } from './ViewIcon';
import { BlurredThumbnailBackdrop } from './BlurredThumbnailBackdrop';
import { VideoControls } from './VideoControls';
import { VideoZoom, type VideoZoomHandle } from './VideoZoom';
import { RelativeTime } from './RelativeTime';
import { formatEventDateTime } from '../utils/format';
import { useVideoStallRetry } from '../hooks/useVideoStallRetry';
import { usePlaybackBeacon } from '../hooks/usePlaybackBeacon';
import { useScrubCacheLifetime } from '../hooks/useScrubCacheLifetime';
import { computeBufferOverlay } from '../lib/bufferOverlayMath';
import { canStep, stepOnGrid } from '../lib/frameStep';

interface Props {
  event: CameraEvent;
  view: ViewId;
  events: CameraEvent[];
  onClose: () => void;
  onNavigate: (event: CameraEvent, view: ViewId) => void;
}

/**
 * Resolve the view to play when an event opens or the user navigates to
 * a sibling — preserve the previously-chosen view id if it exists on the
 * new event, otherwise fall back to the primary (first) view.
 */
function pickViewForEvent(ev: CameraEvent, preferred: ViewId): ViewId {
  if (ev.views.some(l => l.id === preferred)) return preferred;
  return ev.views[0]?.id ?? preferred;
}

function fmtMB(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VideoPlayer({ event, view, events, onClose, onNavigate }: Props) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerBodyRef = useRef<HTMLDivElement>(null);
  const [videoSrc, setVideoSrc] = useState('');
  const [currentView, setCurrentView] = useState<ViewId>(view);
  const objectUrlRef = useRef<string | null>(null);
  const transformRef = useRef<VideoZoomHandle | null>(null);
  // `seekPending` mirrors the Timeline view: armed when handleViewSwitch
  // (or the cache-upgrade swap) writes a pending offset, cleared once
  // the central restore effect lands the seek. Drives the same visible
  // buffer overlay so a view switch on a 23-second offset shows
  // "Seeking…" instead of a player that looks like it just snapped to
  // zero.
  const [seekPending, setSeekPending] = useState(false);
  // <video> waiting/loadstart fire while the new src is fetching/parsing
  // bytes (typical right after src swap). Combined with seekPending the
  // overlay covers the whole "click view → land at the right offset"
  // path.
  const [videoBuffering, setVideoBuffering] = useState(false);
  // See TimelineView.tsx for the rationale — sum of `v.buffered`
  // ranges in seconds, not `end(last)`.
  const [bufferedSec, setBufferedSec] = useState<number | null>(null);
  const [videoTotalBytes, setVideoTotalBytes] = useState<number | null>(null);
  // Snapshotted at loadedmetadata/durationchange. Used to compute the
  // "to start" byte threshold in the buffer overlay — we read it from
  // state (not videoRef.current.duration) so the render stays pure
  // (react-hooks/refs lint).
  const [videoDurationSec, setVideoDurationSec] = useState<number | null>(null);

  const [frameGrid, setFrameGrid] = useState<number[]>([]);
  // Mirrors VideoControls' bar visibility so the zoom / frame-step controls
  // can auto-hide together with the playback bar. Gated on fullscreen below:
  // in the windowed modal the zoom cluster always stays interactive (the
  // playback bar still auto-hides there, but the zoom controls don't), so a
  // direct click never lands on the video underneath.
  const [chromeVisible, setChromeVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const currentIndex = events.findIndex(e => e.id === event.id);
  const showViewToggle = event.views.length >= 2;
  const currentViewRow = event.views.find(l => l.id === currentView) ?? event.views[0];
  const hasVideo = !!currentViewRow;
  const currentFile = currentViewRow?.videoRelPath ?? null;


  // Shared "pending seek" ref so the view-switch handler and the
  // cache-upgrade swap don't fight over the new video element's
  // currentTime. Each path that wants to preserve a playback offset
  // across a src change writes to this ref BEFORE setVideoSrc; a single
  // event-listener block reads it back on loadedmetadata / loadeddata /
  // durationchange and applies the seek once the new source is parsed
  // enough to accept it. Cleared on first successful apply.
  const pendingSeekRef = useRef(0);

  const [accessLocked, setAccessLocked] = useState(false);

  const loadVideo = useCallback(async (eid: string, l: ViewId) => {
    if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
    let src: { videoUrl: string; totalBytes: number | null };
    try {
      src = await api.getVideoUrl(eid, l);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.body?.code === 'ACCOUNT_LOCKED') { setAccessLocked(true); return; }
      throw err;
    }
    const { videoUrl, totalBytes } = src;
    setAccessLocked(false);
    setVideoSrc(videoUrl);
    setVideoTotalBytes(totalBytes);
    setFrameGrid([]);
    api.getFrameGrid(eid, l).then(setFrameGrid).catch(() => setFrameGrid([]));
  }, []);

  // Load video when event or view changes
  useEffect(() => {
    transformRef.current?.resetTransform();
    loadVideo(event.id, currentView);
    return () => { if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; } };
  }, [event.id, currentView, loadVideo]);

  // Bind the player source. Clips are short (Reolink) and the server
  // serves a clean faststart MP4 (front-loaded moov) on the `?fmt=clean`
  // direct endpoint, so a plain progressive `<video src>` plays fine —
  // no HLS/MSE/segmentation needed. Assign the URL + load(); tear it down
  // on cleanup so a stale source doesn't bleed into the next event/view.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!videoSrc) return;
    video.src = videoSrc;
    video.load();
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }, [videoSrc]);

  // (Removed: dedicated Range:bytes=0-0 probe-fetch. videoTotalBytes is
  // populated from the media-token response inside loadVideo above.)

  // View switch (wide ↔ zoom) — preserve the current playback offset so
  // the user picks up where they left off instead of restarting at zero.
  // Writes the captured offset to pendingSeekRef and lets the central
  // restore effect apply it after the new <video src> mounts. The
  // earlier per-handler listener approach raced with the cache-upgrade
  // useEffect's own loadeddata listener, which captured a savedTime of
  // 0 (the freshly-mounted src's currentTime) and overwrote our
  // restore — pinning a single ref keeps the offset under one writer.
  const handleViewSwitch = useCallback((newView: ViewId) => {
    if (newView === currentView) return;
    const v = videoRef.current;
    if (v && Number.isFinite(v.currentTime) && v.currentTime > 0.5) {
      pendingSeekRef.current = v.currentTime;
      setSeekPending(true);
    }
    setCurrentView(newView);
    onNavigate(event, newView);
  }, [currentView, event, onNavigate]);

  // Central restore: any time the active <video> finishes parsing
  // metadata (loadedmetadata), gets a duration update (durationchange,
  // covers the broken-MOOV deferred-duration case the Timeline player
  // hits), or first frame is buffered (loadeddata), apply pendingSeekRef
  // if non-zero. Clamp to the perceived duration the same way the
  // Timeline does so a wrong moov atom doesn't kick currentTime to a
  // fake-EOF. Once successfully applied, clear the ref via 'seeked' so
  // we don't yank the user around if they manually scrub later.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const trySeek = () => {
      const target = pendingSeekRef.current;
      if (target <= 0) return;
      if (!Number.isFinite(v.duration) || v.duration <= 0) return;
      const clamped = Math.min(target, Math.max(0, v.duration - 0.1));
      if (Math.abs(v.currentTime - clamped) > 0.25) v.currentTime = clamped;
    };
    const onSeeked = () => {
      const target = pendingSeekRef.current;
      if (target > 0 && Math.abs(v.currentTime - target) < 1.5) {
        pendingSeekRef.current = 0;
        setSeekPending(false);
      }
    };
    v.addEventListener('loadedmetadata', trySeek);
    v.addEventListener('loadeddata', trySeek);
    v.addEventListener('durationchange', trySeek);
    v.addEventListener('seeked', onSeeked);
    return () => {
      v.removeEventListener('loadedmetadata', trySeek);
      v.removeEventListener('loadeddata', trySeek);
      v.removeEventListener('durationchange', trySeek);
      v.removeEventListener('seeked', onSeeked);
    };
  }, [videoSrc]);

  // Track <video> buffering state via loadstart / waiting / loadeddata /
  // playing / canplay — same plumbing as the Timeline inline player. The
  // opaque overlay is intentionally limited to the INITIAL load. Once the
  // user has seen the first frame, mid-playback `waiting` events (network
  // slower than decode) used to flip the overlay back on and hide the
  // video + native controls — the user could no longer seek back, see how
  // much had been buffered, or estimate how much was left. After
  // first-frame, we trust the browser's built-in buffering spinner on the
  // native <video> chrome and keep our overlay off. The flag resets every
  // time `videoSrc` changes (new event / new view) because the effect
  // re-runs.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let firstFrameSeen = v.readyState >= 2;
    setVideoBuffering(!firstFrameSeen);
    setBufferedSec(null);
    setVideoDurationSec(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    const onWaiting = () => {
      if (firstFrameSeen) return; // mid-playback stall → leave to native UI
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
  }, [videoSrc]);

  // Auto-retry the source when the network stalls during initial load.
  // Driven entirely by the videoRef + the resolved videoSrc; the hook owns
  // its own listeners and timers and does NOT touch currentTime — the
  // pendingSeekRef-based central restore effect above re-applies any seek
  // once the new src parses metadata.
  const stallRetry = useVideoStallRetry(videoRef, videoSrc || null);

  // Free this recording's bytes in the service worker's memory cache when the player closes
  // or switches view.
  useScrubCacheLifetime(videoSrc || null);

  // Playback counts for the activity dashboard — see usePlaybackBeacon. Keyed
  // on the event, not the src, so switching view or a stall-retry reload of the
  // same recording stays one playback.
  usePlaybackBeacon(videoRef, videoSrc ? event.id : null, videoSrc);

  const isVideoLoading = seekPending || videoBuffering || stallRetry.retrying || stallRetry.failed || accessLocked;

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

  const bufferLabel = accessLocked
    ? t('account.lockedPlayback')
    : stallRetry.failed
    ? t('timeline.failedToLoad')
    : stallRetry.retrying
      ? t('timeline.retrying', { count: stallRetry.retryCount, max: 10 })
      : seekPending
        ? 'Seeking to the selected position…'
        : 'Loading video…';

  const stepFrame = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !isFinite(v.duration)) return;
    v.pause();
    const viewRow = event.views.find(vw => vw.id === currentView);
    const fps = viewRow?.frameRate && viewRow.frameRate > 0 ? viewRow.frameRate : 0;
    v.currentTime = stepOnGrid(frameGrid, v.currentTime, dir, fps, v.duration);
  }, [event, currentView, frameGrid]);

  // Drives the step buttons' disabled state — same guards + grid/fps as
  // stepFrame so "disabled" means exactly "stepFrame would be a no-op".
  const canStepFrame = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !isFinite(v.duration)) return false;
    const viewRow = event.views.find(vw => vw.id === currentView);
    const fps = viewRow?.frameRate && viewRow.frameRate > 0 ? viewRow.frameRate : 0;
    return canStep(frameGrid, v.currentTime, dir, fps, v.duration);
  }, [event, currentView, frameGrid]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.contentEditable === 'true') return;
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowLeft' && currentIndex > 0) {
      const prev = events[currentIndex - 1];
      const l = pickViewForEvent(prev, currentView);
      setCurrentView(l); onNavigate(prev, l);
    } else if (e.key === 'ArrowRight' && currentIndex < events.length - 1) {
      const next = events[currentIndex + 1];
      const l = pickViewForEvent(next, currentView);
      setCurrentView(l); onNavigate(next, l);
    } else if (e.key === ',') stepFrame(-1);
    else if (e.key === '.') stepFrame(1);
  }, [currentIndex, currentView, events, onClose, onNavigate, stepFrame]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Track fullscreen so the on-video zoom controls only auto-hide there. The
  // bar tracks the same thing internally; we mirror it here to gate the zoom
  // cluster's visibility (see chromeVisible above).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === playerBodyRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  return (
    <div className="player-overlay" onClick={onClose}>
      <div className="player-container" onClick={e => e.stopPropagation()}>
        <div className="player-header">
          <span className="camera-badge">{event.camera}</span>
          <span className="player-time">
            {formatEventDateTime(event.timestamp)} · <RelativeTime timestamp={event.timestamp} timezone={event.timezone} />
          </span>
          {showViewToggle && (
            <div className="player-view-toggle">
              {event.views.map(l => (
                <button
                  key={l.id}
                  className={`btn-view-toggle ${currentView === l.id ? 'active' : ''}`}
                  onClick={() => handleViewSwitch(l.id)}
                  title={l.label ? t(l.label) : l.id}
                  data-testid={`player-view-${l.id}`}
                >
                  <ViewIcon kind={l.iconKind} />
                </button>
              ))}
            </div>
          )}
          <span className="player-filename" title={getFilename(currentFile)}>{getFilename(currentFile)}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); if (currentFile) api.downloadVideo(event.id, currentView, getFilename(currentFile)); }} className="btn-download" title="Download">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </a>
          <button className="btn-close-player" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="player-body" ref={playerBodyRef}>
          {hasVideo ? (
            <>
              <VideoZoom ref={transformRef} onStep={stepFrame} videoRef={videoRef} canStep={canStepFrame} controlsHidden={isFullscreen && !chromeVisible}>
                <video ref={videoRef} autoPlay playsInline preload="metadata" className="player-video" />
              </VideoZoom>
              <BlurredThumbnailBackdrop eventId={event.id} visible={isVideoLoading} />
              {isVideoLoading && (
                <div className="video-buffer-overlay" data-testid="player-buffer">
                  {!stallRetry.failed && !accessLocked && <div className="spinner" />}
                  <div className="video-buffer-label" data-testid="player-buffer-label">
                    {bufferLabel}
                  </div>
                  {showBufferDetails && bufferedSec !== null && !stallRetry.failed && !stallRetry.retrying && !accessLocked && (() => {
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
                  {stallRetry.failed && !accessLocked && (
                    <div className="video-buffer-actions" data-testid="player-buffer-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => stallRetry.manualRetry()}
                        data-testid="player-buffer-retry"
                      >
                        {t('timeline.retryNow')}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => { stallRetry.cancel(); onClose(); }}
                        data-testid="player-buffer-cancel"
                      >
                        {t('timeline.cancel')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <VideoControls
                videoRef={videoRef}
                containerRef={playerBodyRef}
                mediaKey={videoSrc}
                visible={!isVideoLoading}
                onChromeVisibleChange={setChromeVisible}
              />
            </>
          ) : <div className="no-video">{t('player.noVideo')}</div>}
        </div>
        <div className="player-footer">
          <button className="btn btn-sm" disabled={currentIndex <= 0} onClick={() => {
            const prev = events[currentIndex - 1];
            const l = pickViewForEvent(prev, currentView);
            setCurrentView(l); onNavigate(prev, l);
          }}>&laquo;</button>
          <button className="btn btn-sm" disabled={currentIndex >= events.length - 1} onClick={() => {
            const next = events[currentIndex + 1];
            const l = pickViewForEvent(next, currentView);
            setCurrentView(l); onNavigate(next, l);
          }}>&raquo;</button>
        </div>
      </div>
    </div>
  );
}
