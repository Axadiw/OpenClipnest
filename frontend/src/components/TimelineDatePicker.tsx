import { useState, useEffect, useMemo, useRef } from 'react';
import { addMonths, format, isSameDay, isToday, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isAfter, isBefore } from 'date-fns';
import { enUS, pl, de, fr, it, es, nb } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import { api } from '../api';
import { useTranslation } from '../i18n';

interface Props {
  /** Date currently in the centre of the timeline view — used to seed
   *  the calendar's visible month and to render the "selected" highlight. */
  selectedDate: Date;
  /** Fired when the user clicks a day cell. The Timeline jumps to that
   *  day (00:00 → 24:00). */
  onSelect: (date: Date) => void;
  /** Fired when the popover should close (outside click, Escape, day pick). */
  onClose: () => void;
  /** Where the popover should grow relative to its anchor. The timeline
   *  anchor lives at the bottom edge of the viewport, so it opens upward
   *  ('above'). The FilterBar embeds it inside a downward-flowing panel
   *  and needs 'below'. Default 'above' preserves Timeline behaviour. */
  placement?: 'above' | 'below';
}

/** Format a Date as YYYY-MM-DD using the LOCAL timezone — matches the
 *  `events.date` column server-side which is also a local-time bucket. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Discrete heat buckets driving the day-cell colour. We mix two signals:
 *  the raw `count` (vertical density) and the `cameraCount` (how many
 *  cameras contributed). A day with 50 events from 1 camera reads
 *  differently from 50 across 5 — the bucket roughly reflects "how much
 *  is there to look at on this day".
 *
 *  Returns 0..4. 0 = no events (empty cell); 4 = saturated. */
function heatBucket(count: number, cameraCount: number): number {
  if (count <= 0) return 0;
  // Score weights camera diversity heavier than raw count: a multi-camera
  // day is almost always more interesting than a single camera spamming.
  const score = count + cameraCount * 5;
  if (score >= 50) return 4;
  if (score >= 25) return 3;
  if (score >= 10) return 2;
  return 1;
}

export function TimelineDatePicker({ selectedDate, onSelect, onClose, placement = 'above' }: Props) {
  const { t, language } = useTranslation();
  const localeMap: Record<string, Locale> = { pl, de, fr, it, es, no: nb };
  const locale = localeMap[language] || enUS;

  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(selectedDate));
  const [days, setDays] = useState<Map<string, { count: number; cameraCount: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch the per-day rollup for the visible month + a small overlap so
  // the leading/trailing days from the prev/next month also light up.
  useEffect(() => {
    const gridStart = startOfWeek(startOfMonth(visibleMonth), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(visibleMonth), { weekStartsOn: 1 });
    let cancelled = false;
    setLoading(true);
    api.getEventCalendar(ymd(gridStart), ymd(gridEnd))
      .then(({ days }) => {
        if (cancelled) return;
        const map = new Map<string, { count: number; cameraCount: number }>();
        for (const d of days) map.set(d.date, { count: d.count, cameraCount: d.cameraCount });
        setDays(map);
      })
      .catch(() => { /* network error — leave the map empty, cells stay grey */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visibleMonth]);

  // Build the 6×7 day grid for the visible month — leading/trailing days
  // from neighbouring months keep the layout stable across months.
  const gridDays = useMemo(() => {
    const first = startOfWeek(startOfMonth(visibleMonth), { weekStartsOn: 1 });
    const last = endOfWeek(endOfMonth(visibleMonth), { weekStartsOn: 1 });
    const out: Date[] = [];
    let cur = first;
    while (!isAfter(cur, last)) {
      out.push(cur);
      cur = addDays(cur, 1);
    }
    return out;
  }, [visibleMonth]);

  // Outside-click and Escape both dismiss. Don't dismiss on clicks inside
  // the popover so the prev/next-month buttons keep working.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Defer attaching the click listener by one frame so the click that
    // *opened* the popover doesn't immediately close it.
    const timer = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const monthEnd = endOfMonth(visibleMonth);
  const today = new Date();

  return (
    <div ref={popoverRef} className={`timeline-datepicker-popover timeline-datepicker-popover--${placement}`} data-testid="timeline-datepicker">
      <div className="timeline-datepicker-header">
        <button className="btn btn-sm btn-icon"
          onClick={() => setVisibleMonth(m => addMonths(m, -1))}
          title={t('timeline.prevMonth')}
          data-testid="timeline-datepicker-prev">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span className="timeline-datepicker-month">
          {format(visibleMonth, 'LLLL yyyy', { locale })}
        </span>
        <button className="btn btn-sm btn-icon"
          onClick={() => setVisibleMonth(m => addMonths(m, 1))}
          title={t('timeline.nextMonth')}
          // Disable forward nav past the current month — there's no recordings
          // in the future and keeping it lets the user scroll forever.
          disabled={!isBefore(monthEnd, today) && !isSameDay(monthEnd, today)
                    ? false /* allow */
                    : isAfter(visibleMonth, today)}
          data-testid="timeline-datepicker-next">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>

      <div className="timeline-datepicker-weekdays">
        {[1, 2, 3, 4, 5, 6, 0].map(dow => (
          <span key={dow} className="timeline-datepicker-weekday">
            {format(addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), dow === 0 ? 6 : dow - 1), 'EEEEEE', { locale })}
          </span>
        ))}
      </div>

      <div className="timeline-datepicker-grid">
        {gridDays.map(d => {
          const key = ymd(d);
          const info = days.get(key);
          const bucket = info ? heatBucket(info.count, info.cameraCount) : 0;
          const inMonth = d.getMonth() === visibleMonth.getMonth();
          const sel = isSameDay(d, selectedDate);
          const tdy = isToday(d);
          const future = isAfter(d, today);
          const cls = [
            'timeline-datepicker-day',
            `heat-${bucket}`,
            inMonth ? '' : 'out-of-month',
            sel ? 'selected' : '',
            tdy ? 'today' : '',
            future ? 'future' : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={key}
              className={cls}
              data-testid={`timeline-datepicker-day-${key}`}
              data-heat={bucket}
              data-event-count={info?.count ?? 0}
              data-camera-count={info?.cameraCount ?? 0}
              disabled={future}
              onClick={() => { onSelect(d); onClose(); }}
              title={info ? t('timeline.dayActivity', { count: info.count, cameras: info.cameraCount }) : undefined}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      <div className="timeline-datepicker-footer">
        <button className="btn btn-sm" onClick={() => { onSelect(today); onClose(); }} data-testid="timeline-datepicker-today">
          {t('timeline.today')}
        </button>
        {loading && <span className="timeline-datepicker-loading">{t('timeline.loading')}</span>}
      </div>
    </div>
  );
}
