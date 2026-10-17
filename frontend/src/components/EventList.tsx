import { useMemo, useState, useCallback, useEffect, useRef, type RefCallback } from 'react';
import { format, isToday, isYesterday, formatDistanceToNow, type Locale } from 'date-fns';
import { enUS, pl, de, fr, it, es, nb } from 'date-fns/locale';
import { useTranslation } from '../i18n';
import { EventCard } from './EventCard';
import { EmptyRecordings } from './EmptyRecordings';
import { eventDateAsLocal, forRelativeTime } from '../utils/format';
import type { CameraEvent, ViewId } from '../types';

export type ThumbSize = 'S' | 'M' | 'L';
export const THUMB_WIDTHS: Record<ThumbSize, number> = { S: 180, M: 260, L: 400 };

interface Props {
  events: CameraEvent[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onPlay: (event: CameraEvent, view: ViewId) => void;
  thumbSize: ThumbSize;
  onDelete?: (event: CameraEvent) => void;
  onDeleteDay?: (events: CameraEvent[]) => void;
  editMode?: boolean;
  selectedDays?: Set<string>;
  onToggleDaySelected?: (dayKey: string, events: CameraEvent[]) => void;
  /** Shared per-camera palette (from `paletteForCameras`), used to tint each
   *  card's camera-name badge so it matches the timeline + filter colours. */
  cameraColorMap?: Map<string, string>;
  /** True when active filters (cameras / date / time) hid every recording. When
   *  the grid is empty, this switches the empty state from the first-time
   *  onboarding hint to a "nothing matched your filters" message + Clear
   *  filters action. */
  hasActiveFilter?: boolean;
  /** Resets every filter (cameras + dates/times) and reloads — wired to the
   *  filtered empty state's Clear filters button. */
  onClearFilters?: () => void;
}

export function EventList({ events, total: _total, loading, loadingMore, hasMore, onLoadMore, onPlay, thumbSize, onDelete, onDeleteDay, editMode, selectedDays, onToggleDaySelected, cameraColorMap, hasActiveFilter, onClearFilters }: Props) {
  const { t, language } = useTranslation();
  const localeMap: Record<string, Locale> = { pl, de, fr, it, es, no: nb };
  const locale = localeMap[language] || enUS;

  // Group events by day
  const groupedEvents = useMemo(() => {
    const groups: { label: string; date: Date; events: CameraEvent[]; dayKey: string }[] = [];
    let currentKey = '';

    for (const event of events) {
      const d = eventDateAsLocal(event.timestamp);
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

      if (dayKey !== currentKey) {
        currentKey = dayKey;
        let label: string;
        if (isToday(d)) {
          label = language === 'pl' ? 'Dzisiaj' : 'Today';
        } else if (isYesterday(d)) {
          label = language === 'pl' ? 'Wczoraj' : 'Yesterday';
        } else {
          const dayName = format(d, 'EEEE, d MMMM yyyy', { locale });
          // distance-to-now must use the real UTC moment, not the day-bucket
          // reconstruction `d` — the shifted epoch makes "X days ago" wrong
          // by the user's TZ offset. Day-name format above is fine because
          // it operates on `d`'s wall-clock components.
          const ago = formatDistanceToNow(forRelativeTime(event.timestamp, event.timezone), { addSuffix: true, locale });
          label = `${dayName} (${ago})`;
        }
        groups.push({ label, date: d, events: [], dayKey });
      }
      groups[groups.length - 1].events.push(event);
    }
    return groups;
  }, [events, locale, language]);

  const gridStyle = { '--card-min-width': `${THUMB_WIDTHS[thumbSize]}px` } as React.CSSProperties;

  // Track which day is currently visible at the top of the scroll area
  const [currentDay, setCurrentDay] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sentinelRef = useRef<HTMLDivElement>(null);

  const setHeaderRef = useCallback((label: string): RefCallback<HTMLDivElement> => {
    return (el) => {
      if (el) headerRefs.current.set(label, el);
      else headerRefs.current.delete(label);
    };
  }, []);

  useEffect(() => {
    const container = listRef.current;
    if (!container || groupedEvents.length === 0) return;

    const observer = new IntersectionObserver(
      () => {
        // Find the last header that's at or above the top of the scroll area
        const containerTop = container.getBoundingClientRect().top;
        let best = '';
        for (const group of groupedEvents) {
          const el = headerRefs.current.get(group.label);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= containerTop + 10) {
            best = group.label;
          }
        }
        if (!best && groupedEvents.length > 0) best = groupedEvents[0].label;
        setCurrentDay(best);
      },
      { root: container, threshold: [0, 1] }
    );

    for (const el of headerRefs.current.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [groupedEvents]);

  // Infinite-scroll sentinel observer. Re-bind whenever the rendered group
  // count changes — appending a batch re-creates the sentinel DOM node and
  // the previous observer would still target a detached element.
  //
  // `root: null` (viewport) is intentional: `.event-list` is not a scroll
  // container (`overflow: visible`), the page itself scrolls on `window`.
  // Using a non-scrolling element as the observer root makes Chrome compute
  // intersection against the element's bounding rect — for a sentinel that
  // lives INSIDE that rect, the result is non-deterministic across renders
  // (sometimes fires once at attach, sometimes never), which previously
  // caused the grid to either silently stop loading after the first batch
  // or auto-burn through every page without user scroll.
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore) return;
    const obs = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore) onLoadMore();
      },
      { root: null, rootMargin: '200px 0px', threshold: 0 },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [hasMore, loadingMore, onLoadMore, groupedEvents.length]);

  if (loading && events.length === 0) return <div className="status-msg">{t('events.loading')}</div>;
  if (events.length === 0) return <div className="event-list"><EmptyRecordings filtered={hasActiveFilter} onClearFilters={onClearFilters} /></div>;

  return (
    <>
      {currentDay && currentDay !== groupedEvents[0]?.label && <div className="current-day-bar">{currentDay}</div>}
      {editMode && (
        <div className="edit-mode-banner" role="status">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>{t('events.editModeBanner')}</span>
        </div>
      )}
      <div className={`event-list${editMode ? ' event-list-edit' : ''}`} ref={listRef}>
        {groupedEvents.map((group, gi) => {
          const checked = !!selectedDays && selectedDays.has(group.dayKey);
          return (
          <div key={group.dayKey}>
            <div className={`day-header${gi === 0 ? ' day-header-first' : ''}${checked ? ' day-header-selected' : ''}`} ref={setHeaderRef(group.label)}>
              {editMode && onToggleDaySelected && (
                <label className="day-select" title={t('events.selectDay')}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleDaySelected(group.dayKey, group.events)}
                  />
                </label>
              )}
              <span>{group.label}</span>
              {onDeleteDay && (
                <button className="btn btn-sm day-delete" onClick={() => onDeleteDay(group.events)} title={t('events.deleteDay')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                  <span>{t('events.deleteDay')} ({group.events.length})</span>
                </button>
              )}
            </div>
            <div className="event-grid" style={gridStyle}>
              {group.events.map(event => (
                <EventCard key={event.id} event={event}
                  onPlay={onPlay}
                  onDelete={onDelete}
                  cameraColor={cameraColorMap?.get(event.camera)} />
              ))}
            </div>
          </div>
          );
        })}
        {hasMore && <div ref={sentinelRef} className="infinite-sentinel" aria-hidden />}
        {loadingMore && <div className="status-msg status-msg-inline">{t('events.loading')}</div>}
      </div>
    </>
  );
}
