import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { CameraEvent } from '../types';

/** Time-filter modes:
 *  - `daily`: pick a date range and (optionally) a daily HH:MM window mask.
 *    Empty `timeFrom`/`timeTo` = no mask, behaviour matches pre-time-filter
 *    URLs. timeFrom > timeTo means wrap-around through midnight.
 *  - `range`: pick a continuous datetime range `[from, to)` (rangeTo
 *    exclusive). Used when the user wants a narrow window crossing a single
 *    day-boundary (e.g. 01.01 23:00 → 02.01 01:00). In this mode the daily
 *    fields are unused and ignored server-side.
 */
type TimeMode = 'daily' | 'range';

export interface Filters {
  cameras: string[];
  mode: TimeMode;
  /** Daily mode: YYYY-MM-DD */
  dateFrom: string;
  dateTo: string;
  /** Daily mode: HH:MM (zero-padded). Empty = no mask. Both-or-neither — half
   * a mask is dropped server-side. */
  timeFrom: string;
  timeTo: string;
  /** Range mode: YYYY-MM-DDTHH:MM (datetime-local input shape). */
  rangeFrom: string;
  rangeTo: string;
}

/**
 * True when the filter set actually narrows results — i.e. clearing it would
 * change what the grid shows. Drives the grid's empty-state copy: with active
 * filters, "0 events" means "nothing matched your filters" (offer Clear),
 * not "you have no recordings at all".
 *
 * Semantics mirror the iOS app (EventsStore.hasActiveFilter) so both clients
 * agree on what counts as "filtered":
 *   - any selected camera → active;
 *   - range mode → active only when BOTH ends are set (a half-open range from
 *     a single input is treated as not-yet-applied);
 *   - daily mode → active when either date bound is set, or a full HH:MM
 *     time-of-day mask (both ends) is set.
 * Fields belonging to the inactive mode are ignored.
 */
export function hasActiveFilter(filters: Filters): boolean {
  if (filters.cameras.length > 0) return true;
  if (filters.mode === 'range') {
    return filters.rangeFrom !== '' && filters.rangeTo !== '';
  }
  return (
    filters.dateFrom !== '' ||
    filters.dateTo !== '' ||
    (filters.timeFrom !== '' && filters.timeTo !== '')
  );
}

interface RecordingsState {
  events: CameraEvent[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /**
   * Opaque cursor for the NEXT page. `null` means there are no more events
   * to load. Keyset pagination — see server/db.ts `getEvents` — replaces
   * the old offset-based scheme that was vulnerable to row-shifts from
   * concurrent uploads (cameras adding new events at the top of the list
   * between page fetches caused duplicates + time-jumps in the rendered
   * grid).
   */
  nextCursor: string | null;
}

const BATCH_SIZE = 50;
const MAX_REFRESH_WINDOW = 1000;

interface UrlState {
  filters: Filters;
}

export function readParams(params: URLSearchParams): UrlState {
  const camerasParam = params.get('cameras');
  const cameras = camerasParam ? camerasParam.split(',').filter(Boolean) : [];

  const modeParam = params.get('mode');
  const mode: TimeMode = modeParam === 'daily' ? 'daily' : 'range';
  const dateFrom = params.get('dateFrom') || '';
  const dateTo = params.get('dateTo') || '';
  const timeFrom = params.get('timeFrom') || '';
  const timeTo = params.get('timeTo') || '';
  const rangeFrom = params.get('from') || '';
  const rangeTo = params.get('to') || '';

  return { filters: { cameras, mode, dateFrom, dateTo, timeFrom, timeTo, rangeFrom, rangeTo } };
}

/** Mutate `params` in place to reflect filters, trimming defaults so pristine
 * URLs stay clean. Page/limit are NOT in the URL — infinite scroll accumulates
 * in component state and the URL only persists the filter set. */
function writeParams(params: URLSearchParams, filters: Filters) {
  if (filters.cameras.length > 0) params.set('cameras', filters.cameras.join(',')); else params.delete('cameras');
  // `mode=range` is the default — only persist when explicitly switched to
  // daily, so clean URLs omit mode= entirely for the common case.
  if (filters.mode === 'daily') params.set('mode', 'daily'); else params.delete('mode');
  if (filters.mode === 'daily') {
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom); else params.delete('dateFrom');
    if (filters.dateTo) params.set('dateTo', filters.dateTo); else params.delete('dateTo');
    if (filters.timeFrom) params.set('timeFrom', filters.timeFrom); else params.delete('timeFrom');
    if (filters.timeTo) params.set('timeTo', filters.timeTo); else params.delete('timeTo');
    params.delete('from');
    params.delete('to');
  } else {
    if (filters.rangeFrom) params.set('from', filters.rangeFrom); else params.delete('from');
    if (filters.rangeTo) params.set('to', filters.rangeTo); else params.delete('to');
    params.delete('dateFrom');
    params.delete('dateTo');
    params.delete('timeFrom');
    params.delete('timeTo');
  }
  // Legacy paginator params from older URLs — strip them on first write so the
  // address bar matches the new contract. `offset` was the contract from the
  // very short-lived v0.10.167 PR #169 (replaced by cursor-based keyset in the
  // next version); `page`/`limit` go back further.
  params.delete('page');
  params.delete('limit');
  params.delete('offset');
  params.delete('cursor');
}

/** Project the URL-level Filters into the api.getEvents() query shape.
 * Mode-specific params are gated so we never send `timeFrom` while in range
 * mode (server would ignore them, but it keeps the wire-level payload clean). */
function filtersToQuery(filters: Filters) {
  return {
    camera: filters.cameras.length > 0 ? filters.cameras : undefined,
    mode: filters.mode,
    dateFrom: filters.mode === 'daily' ? (filters.dateFrom || undefined) : undefined,
    dateTo: filters.mode === 'daily' ? (filters.dateTo || undefined) : undefined,
    timeFrom: filters.mode === 'daily' ? (filters.timeFrom || undefined) : undefined,
    timeTo: filters.mode === 'daily' ? (filters.timeTo || undefined) : undefined,
    rangeFrom: filters.mode === 'range' ? (filters.rangeFrom || undefined) : undefined,
    rangeTo: filters.mode === 'range' ? (filters.rangeTo || undefined) : undefined,
  };
}

/**
 * Single source of truth for filters: the URL search params.
 *
 * `filters` are *derived* from `useSearchParams` via useMemo. `updateFilters`
 * writes to the URL via `setSearchParams`; the URL change re-derives state
 * and a useEffect resets the accumulated event list and fetches the first
 * batch. Events themselves live in component state and grow via `loadMore`.
 *
 * Filters in URL means: reload preserves them, back/forward navigates
 * between filter-sets, deep-links (e.g. `/grid?cameras=cam1`) work cold.
 */
export function useRecordings() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Stable string keys for `useEffect` deps — using `searchParams` itself
  // would trigger every render (it's a new object) and loop.
  const camerasStr = searchParams.get('cameras') ?? '';
  const modeStr = searchParams.get('mode') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  const timeFrom = searchParams.get('timeFrom') ?? '';
  const timeTo = searchParams.get('timeTo') ?? '';
  const rangeFrom = searchParams.get('from') ?? '';
  const rangeTo = searchParams.get('to') ?? '';

  const urlState = useMemo<UrlState>(
    () => readParams(searchParams),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camerasStr, modeStr, dateFrom, dateTo, timeFrom, timeTo, rangeFrom, rangeTo],
  );

  const { filters } = urlState;

  const [state, setState] = useState<RecordingsState>({
    events: [],
    total: 0,
    loading: false,
    loadingMore: false,
    error: null,
    nextCursor: null,
  });

  const [cameras, setCameras] = useState<string[]>([]);

  const loadCameras = useCallback(async () => {
    try {
      const result = await api.getCameras();
      setCameras(result.cameras);
    } catch {
      // ignore
    }
  }, []);

  // `enabledRef` opt-in: TimelineRoute uses this hook for filters/cameras/tags
  // but never wants the events fetch to fire. Components opt in via
  // `loadEvents()` on mount.
  const enabledRef = useRef(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  // Bumped on every reset (filter change OR reload counter tick). A `loadMore`
  // whose seq is stale at resolve-time is discarded — prevents an in-flight
  // page-2 fetch from appending after the user changed a filter.
  const resetSeqRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Reset effect — clears the accumulated list and fetches the first batch.
  useEffect(() => {
    if (!enabledRef.current) return;
    let cancelled = false;
    resetSeqRef.current += 1;
    setState(s => ({ ...s, loading: true, error: null, events: [], total: 0, nextCursor: null }));
    api.getEvents({
      ...filtersToQuery(filters),
      limit: BATCH_SIZE,
    }).then(result => {
      if (cancelled) return;
      setState({
        events: result.events,
        total: result.total,
        loading: false,
        loadingMore: false,
        error: null,
        nextCursor: result.nextCursor,
      });
    }).catch(err => {
      if (cancelled) return;
      setState(s => ({ ...s, loading: false, error: (err as Error).message }));
    });
    return () => { cancelled = true; };
  // The deps mirror every URL param `filtersToQuery` reads. Trimming them
  // (as PR #235 accidentally did) makes Apply a no-op for everything except
  // cameras + date-from/-to: the URL updates but the events fetch never
  // re-runs, so the filter only takes effect after a full page reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camerasStr, modeStr, dateFrom, dateTo, timeFrom, timeTo, rangeFrom, rangeTo, reloadCounter]);

  /**
   * Two legitimate call shapes:
   *  - `loadEvents()` — initial mount: enable the hook and kick off the first fetch.
   *  - `loadEvents(undefined, undefined, undefined, false)` — silent refresh.
   *    Two branches inside, by `loadedCount`:
   *
   *    a) `loadedCount <= MAX_REFRESH_WINDOW` — refetch the top N events
   *       (no cursor → server returns the newest N) and REPLACE the events
   *       array. Same-length swap, so the user's scroll position stays
   *       meaningful while new events at the top come in.
   *
   *    b) `loadedCount > MAX_REFRESH_WINDOW` — the user is deep-scrolled
   *       past the cap. We MUST NOT refetch only the top 1000 and replace —
   *       that would truncate the events array, drop the deep-tail rows
   *       (e.g. April 1-13), and the browser would clamp the user's scroll
   *       to the new end (~April 14-15). The user-visible symptom is the
   *       grid jumping from "around April 1" to "around April 15" mid-
   *       scroll, then loadMore appending older rows below that.
   *       In this branch we ONLY refresh `total` (a cheap COUNT(*) via
   *       `limit: 1`) so the toolbar count stays accurate, and leave
   *       events/nextCursor untouched. New top-of-list events won't render
   *       until the user navigates away and back, which is the right
   *       trade — silently reordering a 1500-row scroll position is
   *       worse than slightly stale "newest" content.
   */
  const loadEvents = useCallback(async (
    _nextPage?: number,
    _nextFilters?: Filters,
    _limitOverride?: number,
    pushHistory: boolean = true,
  ) => {
    enabledRef.current = true;
    if (pushHistory) {
      // No-arg initial fetch. Bumping the counter triggers the reset effect.
      setReloadCounter(n => n + 1);
      return;
    }
    // Silent refresh — refetch the current window without resetting `loading`.
    const loadedCount = stateRef.current.events.length;
    if (loadedCount === 0) {
      // Nothing loaded yet — fall back to a normal reset.
      setReloadCounter(n => n + 1);
      return;
    }
    const seqAtStart = resetSeqRef.current;
    // Branch (b): user is past the refresh-window cap → only refresh `total`,
    // leave the events array + cursor alone so a deep scroll isn't truncated.
    if (loadedCount > MAX_REFRESH_WINDOW) {
      try {
        const result = await api.getEvents({
          camera: filters.cameras.length > 0 ? filters.cameras : undefined,
          dateFrom: filters.dateFrom || undefined,
          dateTo: filters.dateTo || undefined,
          limit: 1,
        });
        if (seqAtStart !== resetSeqRef.current) return;
        setState(s => ({ ...s, total: result.total, error: null }));
      } catch (err) {
        if (seqAtStart !== resetSeqRef.current) return;
        setState(s => ({ ...s, error: (err as Error).message }));
      }
      return;
    }
    // Branch (a): normal window refresh — same length, replaces array.
    const refreshLimit = loadedCount;
    try {
      const result = await api.getEvents({
        ...filtersToQuery(filters),
        limit: refreshLimit,
      });
      if (seqAtStart !== resetSeqRef.current) return;
      setState(s => ({
        ...s,
        events: result.events,
        total: result.total,
        nextCursor: result.nextCursor,
        error: null,
      }));
    } catch (err) {
      if (seqAtStart !== resetSeqRef.current) return;
      setState(s => ({ ...s, error: (err as Error).message }));
    }
  }, [filters]);

  /** Append the next batch of events. Called by the infinite-scroll sentinel
   * when the user reaches the bottom. */
  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (!enabledRef.current) return;
    if (loadingMoreRef.current) return;
    const current = stateRef.current;
    if (!current.nextCursor) return;  // server signalled "no more rows"
    if (current.loading) return;
    loadingMoreRef.current = true;
    const seqAtStart = resetSeqRef.current;
    const cursor = current.nextCursor;
    setState(s => ({ ...s, loadingMore: true }));
    try {
      const result = await api.getEvents({
        ...filtersToQuery(filters),
        cursor,
        limit: BATCH_SIZE,
      });
      if (seqAtStart !== resetSeqRef.current) return;
      setState(s => {
        // Race guard: the 60-second silent refresh replaces both the events
        // array AND `nextCursor` without bumping `resetSeqRef` (it's not a
        // "reset" in the filter-change sense). If a silent refresh landed
        // while this loadMore was in flight, the `cursor` we sent to the
        // server is now stale — appending its result on top of the freshly
        // refreshed array splices a NEWER batch (from the pre-refresh
        // boundary) AFTER an OLDER batch (the refresh's truncated tail),
        // producing the "March 30 then April 18 below it" symptom in the
        // grid. If the cursor we used is no longer the current state's
        // nextCursor, drop the result on the floor — the sentinel will
        // re-fire on next scroll with the up-to-date cursor.
        if (s.nextCursor !== cursor) return { ...s, loadingMore: false };
        return {
          ...s,
          events: [...s.events, ...result.events],
          total: result.total,
          nextCursor: result.nextCursor,
          loadingMore: false,
          error: null,
        };
      });
    } catch (err) {
      if (seqAtStart !== resetSeqRef.current) return;
      setState(s => ({ ...s, loadingMore: false, error: (err as Error).message }));
    } finally {
      loadingMoreRef.current = false;
    }
  }, [filters]);

  const updateFilters = useCallback((newFilters: Partial<Filters>) => {
    enabledRef.current = true;
    const updated = { ...filters, ...newFilters };
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      writeParams(next, updated);
      return next;
    });
  }, [filters, setSearchParams]);

  // hasMore is driven by the server-supplied cursor, NOT by comparing
  // `events.length < total`. Concurrent uploads keep growing `total` while
  // we paginate, so a length-vs-total check would loop forever; the cursor
  // is the authoritative "more rows past this point" signal.
  const hasMore = state.nextCursor !== null;

  return {
    ...state,
    hasMore,
    cameras,
    filters,
    hasActiveFilter: hasActiveFilter(filters),
    loadCameras,
    loadEvents,
    loadMore,
    updateFilters,
  };
}
