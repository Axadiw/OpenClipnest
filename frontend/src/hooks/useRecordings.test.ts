import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { readParams, useRecordings, hasActiveFilter, type Filters } from './useRecordings';

function mkFilters(overrides: Partial<Filters> = {}): Filters {
  return {
    cameras: [],
    mode: 'range',
    dateFrom: '',
    dateTo: '',
    timeFrom: '',
    timeTo: '',
    rangeFrom: '',
    rangeTo: '',
    ...overrides,
  };
}

describe('hasActiveFilter', () => {
  it('is false for pristine filters (no cameras, range mode, all empty)', () => {
    expect(hasActiveFilter(mkFilters())).toBe(false);
  });

  it('is true when any camera is selected', () => {
    expect(hasActiveFilter(mkFilters({ cameras: ['Front'] }))).toBe(true);
  });

  it('is true in range mode only when BOTH ends are set', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'range', rangeFrom: '2026-05-20T08:00', rangeTo: '2026-05-20T18:00' }))).toBe(true);
    // A half-open range (one end missing) is not a constraint that should
    // flip the empty-state to "filtered" — mirrors iOS EventsStore.swift.
    expect(hasActiveFilter(mkFilters({ mode: 'range', rangeFrom: '2026-05-20T08:00' }))).toBe(false);
    expect(hasActiveFilter(mkFilters({ mode: 'range', rangeTo: '2026-05-20T18:00' }))).toBe(false);
  });

  it('is true in daily mode when a single date bound is set', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'daily', dateFrom: '2026-05-20' }))).toBe(true);
    expect(hasActiveFilter(mkFilters({ mode: 'daily', dateTo: '2026-05-20' }))).toBe(true);
  });

  it('is true in daily mode only when BOTH time-of-day ends are set', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'daily', timeFrom: '08:00', timeTo: '18:00' }))).toBe(true);
    expect(hasActiveFilter(mkFilters({ mode: 'daily', timeFrom: '08:00' }))).toBe(false);
    expect(hasActiveFilter(mkFilters({ mode: 'daily', timeTo: '18:00' }))).toBe(false);
  });

  it('is false in daily mode with no date and no time mask', () => {
    expect(hasActiveFilter(mkFilters({ mode: 'daily' }))).toBe(false);
  });

  it('ignores range fields while in daily mode and vice versa', () => {
    // rangeFrom/To set but mode is daily → not active (those fields are inert).
    expect(hasActiveFilter(mkFilters({ mode: 'daily', rangeFrom: '2026-05-20T08:00', rangeTo: '2026-05-20T18:00' }))).toBe(false);
    // dateFrom set but mode is range → not active.
    expect(hasActiveFilter(mkFilters({ mode: 'range', dateFrom: '2026-05-20' }))).toBe(false);
  });
});

describe('readParams default mode', () => {
  it('defaults mode to "range" when URL has no mode= parameter', () => {
    const params = new URLSearchParams('');
    const result = readParams(params);
    expect(result.filters.mode).toBe('range');
  });

  it('respects explicit mode=daily in URL', () => {
    const params = new URLSearchParams('mode=daily');
    const result = readParams(params);
    expect(result.filters.mode).toBe('daily');
  });

  it('respects explicit mode=range in URL', () => {
    const params = new URLSearchParams('mode=range');
    const result = readParams(params);
    expect(result.filters.mode).toBe('range');
  });
});

// Regression: PR #235 trimmed the reset effect's dep array to
// `[camerasStr, dateFrom, dateTo, reloadCounter]`, so flipping any other
// filter (mode, timeFrom/To, rangeFrom/To) wrote to the URL but never
// re-fetched. Filters only "took effect" after a full page reload.
// This block tests that Apply on each filter type triggers a refetch.

vi.mock('../api', () => ({
  api: {
    getCameras: vi.fn().mockResolvedValue({ cameras: ['Front', 'Back'] }),
    getEvents: vi.fn().mockResolvedValue({ events: [], total: 0, nextCursor: null }),
  },
}));

// Imported lazily so the mock above is set up before the hook reads it.
async function mockedApi() {
  return (await import('../api')).api as unknown as {
    getEvents: ReturnType<typeof vi.fn>;
    getCameras: ReturnType<typeof vi.fn>;
  };
}

function wrapperWithUrl(initialUrl: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [initialUrl] }, children);
}

describe('useRecordings — updateFilters triggers refetch (regression for PR #235 dep-array trim)', () => {
  beforeEach(async () => {
    const api = await mockedApi();
    api.getEvents.mockClear();
  });

  it('changing timeFrom (daily mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid?mode=daily&dateFrom=2026-05-20&dateTo=2026-05-20'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ timeFrom: '08:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ timeFrom: '08:00' });
  });

  it('changing timeTo (daily mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid?mode=daily&dateFrom=2026-05-20&dateTo=2026-05-20'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ timeTo: '18:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ timeTo: '18:00' });
  });

  it('changing rangeFrom (range mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ rangeFrom: '2026-05-20T08:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ rangeFrom: '2026-05-20T08:00' });
  });

  it('changing rangeTo (range mode) refetches with the new value', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ rangeTo: '2026-05-20T18:00' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ rangeTo: '2026-05-20T18:00' });
  });

  it('switching mode (range → daily) refetches', async () => {
    const api = await mockedApi();
    const { result } = renderHook(() => useRecordings(), {
      wrapper: wrapperWithUrl('/grid'),
    });
    act(() => { result.current.loadEvents(); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(1));
    act(() => { result.current.updateFilters({ mode: 'daily', dateFrom: '2026-05-20' }); });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(2));
    expect(api.getEvents.mock.calls[1][0]).toMatchObject({ mode: 'daily', dateFrom: '2026-05-20' });
  });
});
