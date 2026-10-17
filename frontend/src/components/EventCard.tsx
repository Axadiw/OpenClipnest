import { memo, useEffect, useMemo, useState, useCallback } from 'react';
import { isToday } from 'date-fns';
import { api } from '../api';
import { useTranslation } from '../i18n';
import { useInView } from '../hooks/useInView';
import { AuthImage } from './AuthImage';
import { RelativeTime } from './RelativeTime';
import { ViewIcon } from './ViewIcon';
import { formatEventDateTime, formatEventTime, eventDateAsLocal, formatDuration } from '../utils/format';
import type { CameraEvent, ViewId } from '../types';

interface Props {
  event: CameraEvent;
  onPlay: (event: CameraEvent, view: ViewId) => void;
  onDelete?: (event: CameraEvent) => void;
  /** Camera's palette colour (from the shared `paletteForCameras`). When set,
   *  tints the camera-name badge so it reads as the same hue as the timeline. */
  cameraColor?: string;
}

function EventCardInner({ event, onPlay, onDelete, cameraColor }: Props) {
  const { t } = useTranslation();
  const showViewButtons = event.views.length >= 2;
  const [cardRef, isVisible] = useInView();
  // `eventDateAsLocal` rebuilds the TZ-shifted wall-clock Date used by
  // `isToday`. `formatEventDateTime` / `formatEventTime` hit cached
  // `Intl.DateTimeFormat` instances under the hood — still cheap to memo
  // since they're called for ~50 cards on every parent re-render. The
  // "today?" gate determines whether we show the live `<RelativeTime>` at
  // all; not-today events get a static clock time only.
  const { fullTime, clockTime, isTodayEvent } = useMemo(() => ({
    fullTime: formatEventDateTime(event.timestamp),
    clockTime: formatEventTime(event.timestamp),
    isTodayEvent: isToday(eventDateAsLocal(event.timestamp)),
  }), [event.timestamp]);

  // Thumbnails are generated asynchronously by the thumbnail worker, so a
  // freshly uploaded event often arrives without one. When the card is
  // visible and the thumbnail is still missing, poll the event detail every
  // 3s until it appears. The worker tombstones permanently-unprocessable
  // videos with '__unplayable__' (corrupt MP4s) or events that exceeded
  // the retry budget. The listing also exposes
  // a `thumbnailFailed` boolean so the frontend doesn't need to know the
  // sentinel string. Treat that as a terminal state so we stop polling and
  // render the placeholder.
  const THUMBNAIL_UNPLAYABLE = '__unplayable__';
  const [thumbnail, setThumbnail] = useState<string | null | undefined>(event.thumbnail);
  useEffect(() => { setThumbnail(event.thumbnail); }, [event.thumbnail]);
  const isUnplayable = event.thumbnailFailed === true || thumbnail === THUMBNAIL_UNPLAYABLE;
  useEffect(() => {
    if (thumbnail || !isVisible) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { event: fresh } = await api.getEvent(event.id);
        if (!cancelled && fresh?.thumbnail) setThumbnail(fresh.thumbnail);
      } catch { /* transient; retry next tick */ }
    };
    const handle = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(handle); };
  }, [thumbnail, isVisible, event.id]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete) return;
    onDelete(event);
  }, [onDelete, event]);

  // Click thumbnail → play primary view (first entry in event.views[]).
  // Server-side gating (events.playback_ready + playback_unplayable) means
  // we only ever render events that are ready to play, so no transcode-
  // state placeholders here.
  const handleThumbnailClick = () => {
    const view = event.views[0]?.id;
    if (view) onPlay(event, view);
  };

  return (
    <div className="event-card" ref={cardRef}>
      <div className="event-thumbnail" onClick={handleThumbnailClick}>
        {isUnplayable ? (
          <div className="no-thumbnail" title={t('events.thumbnail_unplayable')}><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M4 5l16 12" stroke="currentColor"/></svg></div>
        ) : thumbnail ? (
          isVisible ? <AuthImage eventId={event.id} alt={event.camera} /> : <div className="no-thumbnail" />
        ) : (
          <div className="no-thumbnail"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><polygon points="9.5 8 9.5 14 15 11 9.5 8" fill="currentColor" stroke="none"/></svg></div>
        )}
        {onDelete && (
          <button className="btn-delete card-delete" onClick={handleDeleteClick} title={t('events.delete')} aria-label={t('events.delete')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </button>
        )}
        <div className="thumbnail-overlay">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="white" opacity="0.9"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div>
        {event.duration != null && (
          <span className="duration-badge">{formatDuration(event.duration)}</span>
        )}
      </div>
      <div className="event-bottom">
        <div className="event-info">
          <span className="camera-badge" style={{ background: cameraColor }}>{event.camera}</span>
          <span className="event-time" title={fullTime}>{clockTime}{isTodayEvent && <span className="time-ago"> (<RelativeTime timestamp={event.timestamp} timezone={event.timezone} />)</span>}</span>
        </div>
        <div className="event-actions">
          {showViewButtons && event.views.map(l => (
            <button
              key={l.id}
              className="btn-view"
              onClick={() => onPlay(event, l.id)}
              title={l.label ? t(l.label) : l.id}
              data-testid={`event-card-view-${l.id}`}
            >
              <ViewIcon kind={l.iconKind} size={14} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Custom equality — the grid re-renders when `useRecordings` returns a new
// top-level object even though the `events` array (and the `event` props on
// each card) are reference-stable. Without this memo every parent tick burns
// CPU re-running EventCardInner for 50 cards × N times/sec.
//
// We DO compare `!!onDelete` because Edit-mode flips it between undefined
// and a function — that controls whether the trash button renders, and
// missing this comparison silently breaks the bulk-delete flow (the v0.10.194
// e2e regression where `bulk-delete.spec.ts` timed out clicking `.btn-delete`
// because the Edit-mode toggle never reached the memoized cards).
//
// `onPlay` / `onDelete` identity beyond that is NOT compared — they're
// recreated each parent render, so comparing identity would defeat the memo.
// As long as those callbacks only depend on the `event` argument they receive
// (which they do today), capturing a "stale" closure is harmless.
function eventCardPropsEqual(prev: Props, next: Props): boolean {
  if (!!prev.onDelete !== !!next.onDelete) return false;
  // Re-render when the camera's palette colour changes (e.g. a camera was
  // added/removed and every hue shifted) even if the event ref is stable.
  if (prev.cameraColor !== next.cameraColor) return false;
  if (prev.event === next.event) return true;
  const a = prev.event, b = next.event;
  if (
    a.id !== b.id
    || a.thumbnail !== b.thumbnail
    || a.thumbnailFailed !== b.thumbnailFailed
    || a.timestamp !== b.timestamp
    || a.timezone !== b.timezone
    || a.camera !== b.camera
    || a.duration !== b.duration
  ) return false;
  // View-array shallow compare: same length AND same (id, videoRelPath)
  // pairs in the same order. Order matters because primary-view lookup
  // uses views[0].
  if (a.views.length !== b.views.length) return false;
  for (let i = 0; i < a.views.length; i++) {
    if (a.views[i].id !== b.views[i].id) return false;
    if (a.views[i].videoRelPath !== b.views[i].videoRelPath) return false;
  }
  return true;
}

export const EventCard = memo(EventCardInner, eventCardPropsEqual);
