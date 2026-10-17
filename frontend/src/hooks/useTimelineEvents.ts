import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';
import type { CameraEvent } from '../types';

/** Get YYYY-MM-DD strings (UTC) for all dates covered by an epoch-ms range */
export function getDatesInRange(startMs: number, endMs: number): string[] {
  const dates: string[] = [];
  const d = new Date(startMs);
  d.setUTCHours(0, 0, 0, 0);          // round to UTC midnight
  while (d.getTime() <= endMs) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);  // step by UTC day
  }
  return dates;
}

/**
 * Decide whether the timeline's 60s background poll should fire on this tick.
 * Skip while the tab is hidden (no point fetching for an unseen view) or while
 * the user is mid-gesture — `idleThresholdMs` is the quiet period after the
 * last pan/zoom before a silent refresh is allowed to swap the strip's data.
 */
export function shouldAutoRefresh(opts: {
  hidden: boolean;
  msSinceInteraction: number;
  idleThresholdMs?: number;
}): boolean {
  if (opts.hidden) return false;
  const threshold = opts.idleThresholdMs ?? 2000;
  return opts.msSinceInteraction >= threshold;
}

/**
 * Continuous timeline data hook.
 * Caches events per date and fetches on demand as the view scrolls.
 */
export function useTimelineEvents(cameraFilter: string[]) {
  const [eventsByDate, setEventsByDate] = useState<Record<string, CameraEvent[]>>({});
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(new Set<string>());
  const cameraKey = cameraFilter.join(',');
  const filterKey = cameraKey;

  // Clear cache when any filter changes
  useEffect(() => {
    setEventsByDate({});
    fetchedRef.current.clear();
  }, [filterKey]);

  const ensureDatesFetched = useCallback(async (startMs: number, endMs: number) => {
    const cameras = cameraKey ? cameraKey.split(',') : [];
    const needed = getDatesInRange(startMs, endMs);
    const toFetch = needed.filter(d => !fetchedRef.current.has(d));

    if (toFetch.length === 0) return;

    // Mark immediately to prevent duplicate fetches
    toFetch.forEach(d => fetchedRef.current.add(d));
    setLoading(true);

    const results = await Promise.all(
      toFetch.map(async (date) => {
        try {
          const r = await api.getEvents({
            dateFrom: date,
            dateTo: date,
            camera: cameras.length > 0 ? cameras : undefined,
            // 1000 is the server-side hard cap (events.ts MAX_LIMIT). The
            // old "limit: 0" meant "all" but the server stopped honoring it
            // in v0.8.17 — it now coerces 0 → 1, which left every timeline
            // day with a single event instead of the camera ribbon. A
            // future refactor can paginate per-day if a user genuinely
            // produces >1k clips a day; for now Reolink throughput tops
            // out around ~250/day per camera.
            limit: 1000,
          });
          return { date, events: r.events };
        } catch {
          return { date, events: [] as CameraEvent[] };
        }
      })
    );

    setEventsByDate(prev => {
      const next = { ...prev };
      for (const { date, events } of results) {
        next[date] = events;
      }
      return next;
    });
    setLoading(false);
  }, [cameraKey]);

  /**
   * Silent background refresh of the currently-visible range. Unlike
   * `ensureDatesFetched`, this *bypasses* the per-date fetched cache so already
   * loaded days pick up new/deleted clips, and it never toggles `loading` — the
   * strip swaps in place with no spinner. A per-date fetch failure keeps that
   * day's existing events instead of blanking it.
   */
  const refreshVisible = useCallback(async (startMs: number, endMs: number) => {
    const cameras = cameraKey ? cameraKey.split(',') : [];
    const dates = getDatesInRange(startMs, endMs);
    if (dates.length === 0) return;

    const results = await Promise.all(
      dates.map(async (date) => {
        try {
          const r = await api.getEvents({
            dateFrom: date,
            dateTo: date,
            camera: cameras.length > 0 ? cameras : undefined,
            limit: 1000, // matches ensureDatesFetched — server-side hard cap
          });
          return { date, events: r.events };
        } catch {
          return null; // keep the stale day rather than blanking it
        }
      })
    );

    setEventsByDate(prev => {
      const next = { ...prev };
      for (const res of results) {
        if (res) next[res.date] = res.events;
      }
      return next;
    });
    dates.forEach(d => fetchedRef.current.add(d));
  }, [cameraKey]);

  return { eventsByDate, loading, ensureDatesFetched, refreshVisible };
}
