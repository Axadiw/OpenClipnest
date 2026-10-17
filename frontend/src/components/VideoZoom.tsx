import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from 'react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { useTranslation } from '../i18n';

/**
 * Imperative handle exposed by {@link VideoZoom}. The grid player keeps its
 * own `<video>` element across event/view switches (no remount), so it resets
 * the zoom transform programmatically. The timeline player instead remounts
 * VideoZoom per clip via a `key`, which resets zoom for free.
 */
export interface VideoZoomHandle {
  resetTransform: () => void;
}

function ZoomControls({ zoomLevel, onStep, canStepBack, canStepForward, hidden }: { zoomLevel: number; onStep: (dir: 1 | -1) => void; canStepBack: boolean; canStepForward: boolean; hidden?: boolean }) {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const { t } = useTranslation();

  return (
    <div className={`zoom-controls${hidden ? ' zoom-controls-hidden' : ''}`}>
      <button className="zoom-btn" data-testid="player-step-back" onClick={() => onStep(-1)} disabled={!canStepBack} title={t('player.stepBack')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="19 20 9 12 19 4 19 20"/>
          <line x1="5" y1="19" x2="5" y2="5"/>
        </svg>
      </button>
      <button className="zoom-btn" data-testid="player-step-forward" onClick={() => onStep(1)} disabled={!canStepForward} title={t('player.stepForward')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="5 4 15 12 5 20 5 4"/>
          <line x1="19" y1="5" x2="19" y2="19"/>
        </svg>
      </button>
      <button className="zoom-btn" onClick={() => zoomIn(0.5)} title={t('player.zoomIn')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
      <span className="zoom-level">{Math.round(zoomLevel * 100)}%</span>
      <button className="zoom-btn" onClick={() => zoomOut(0.5)} disabled={zoomLevel <= 1} title={t('player.zoomOut')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
      <button className="zoom-btn" onClick={() => resetTransform()} disabled={zoomLevel <= 1} title={t('player.zoomReset')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
    </div>
  );
}

interface Props {
  /** The `<video>` element to make zoomable. The caller keeps full control of
   *  its ref/className/data-attributes. */
  children: ReactNode;
  /** Frame step handler wired to the step-back/step-forward buttons. */
  onStep: (dir: 1 | -1) => void;
  /** Ref to the wrapped `<video>`; VideoZoom listens to its time/metadata
   *  events to keep the step buttons' disabled state in sync. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Whether a one-frame step in `dir` would actually move the playhead.
   *  Must be backed by the same frame grid + fps the `onStep` handler uses. */
  canStep: (dir: 1 | -1) => boolean;
  /**
   * Fade out the on-video control bar (frame step + zoom) in lockstep with the
   * playback controls' auto-hide. Defaults to always-shown so the timeline
   * inline player (which uses its own hover-fade) is unaffected.
   */
  controlsHidden?: boolean;
}

/**
 * Shared digital-zoom wrapper for the grid and timeline video players.
 * Owns the zoom state and renders the scroll/pinch/double-click zoom surface
 * plus the on-video control bar (frame step + zoom in/out/reset + level).
 */
export const VideoZoom = forwardRef<VideoZoomHandle, Props>(function VideoZoom({ children, onStep, videoRef, canStep, controlsHidden }, ref) {
  const [zoomLevel, setZoomLevel] = useState(1);
  const [stepAvail, setStepAvail] = useState({ back: false, forward: false });
  const transformRef = useRef<{ resetTransform: () => void } | null>(null);

  useImperativeHandle(ref, () => ({
    resetTransform: () => {
      transformRef.current?.resetTransform();
      setZoomLevel(1);
    },
  }), []);

  // Keep the step buttons' disabled state in sync with the playhead. The grid
  // player keeps one <video> across event/view switches (src changes fire
  // durationchange/loadedmetadata on the same element); the timeline player
  // remounts VideoZoom per clip via a key, re-running this effect on the new
  // element. `canStep` identity changes when the caller's frame grid loads,
  // which also re-runs the effect and recomputes.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => setStepAvail({ back: canStep(-1), forward: canStep(1) });
    sync();
    v.addEventListener('timeupdate', sync);
    v.addEventListener('seeked', sync);
    v.addEventListener('durationchange', sync);
    v.addEventListener('loadedmetadata', sync);
    v.addEventListener('emptied', sync);
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('seeked', sync);
      v.removeEventListener('durationchange', sync);
      v.removeEventListener('loadedmetadata', sync);
      v.removeEventListener('emptied', sync);
    };
  }, [videoRef, canStep]);

  return (
    <TransformWrapper
      ref={transformRef as any}
      initialScale={1}
      minScale={1}
      maxScale={5}
      wheel={{ step: 0.15 }}
      panning={{ velocityDisabled: true, disabled: zoomLevel <= 1 }}
      doubleClick={{ mode: 'reset' }}
      onTransform={(_ref: any, state: { scale: number }) => setZoomLevel(state.scale)}
    >
      <div className="video-zoom-container">
        <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }} contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {children}
        </TransformComponent>
      </div>
      <ZoomControls zoomLevel={zoomLevel} onStep={onStep} canStepBack={stepAvail.back} canStepForward={stepAvail.forward} hidden={controlsHidden} />
    </TransformWrapper>
  );
});
