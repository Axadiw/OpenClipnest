import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useTranslation } from '../i18n';
import { formatClock } from '../lib/videoControls';
import type { ScrubPreviewState } from '../hooks/useScrubPreview';

/** Half the bubble's outer width (160 px frame + padding + border), for the CSS fallback position. */
const HALF_WIDTH_PX = 86;

interface ScrubPreviewBubbleProps {
  state: ScrubPreviewState;
  time: number;
  fraction: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

/**
 * The frame-and-time card above the seek bar while hovering it (mouse/pen) or dragging the knob
 * (touch). Rendered inside the seek track; its centre follows the pointer but is clamped so the
 * card never hangs past either end of the control bar. The track itself can be much narrower than
 * the card (about 60 px on a phone), so the clamp is measured against the whole bar.
 */
export function ScrubPreviewBubble({ state, time, fraction, canvasRef }: ScrubPreviewBubbleProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const track = el?.parentElement;
    if (!el || !track) return;
    const bar = (track.closest('.video-controls') as HTMLElement | null) ?? track;
    const tr = track.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const half = el.offsetWidth / 2;
    if (tr.width <= 0 || br.width < half * 2) return; // keep the CSS fallback
    const x = tr.left + Math.min(1, Math.max(0, fraction)) * tr.width;
    const centre = Math.min(Math.max(x, br.left + half), br.right - half);
    el.style.left = `${(centre - tr.left).toFixed(1)}px`;
  });
  if (state === 'hidden') return null;
  const pct = `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%`;
  const clock = formatClock(time);
  return (
    <div
      ref={ref}
      className="video-controls-preview"
      data-testid="player-seek-preview"
      data-state={state}
      role="img"
      aria-label={t('player.seekPreview', { time: clock })}
      style={{ left: `clamp(${HALF_WIDTH_PX}px, ${pct}, calc(100% - ${HALF_WIDTH_PX}px))` }}
    >
      <canvas ref={canvasRef} className="video-controls-preview-frame" data-testid="player-seek-preview-frame" width={160} height={90} />
      <span className="video-controls-preview-time" data-testid="player-seek-preview-time">{clock}</span>
    </div>
  );
}
