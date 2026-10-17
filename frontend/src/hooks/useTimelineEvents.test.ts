import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTimelineEvents, shouldAutoRefresh } from './useTimelineEvents';

vi.mock('../api', () => ({
  api: {
    getEvents: vi.fn(),
  },
}));

// Imported lazily so the mock above is set up before the hook reads it.
async function mockedApi() {
  return (await import('../api')).api as unknown as {
    getEvents: ReturnType<typeof vi.fn>;
  };
}

// A UTC day's worth of epoch-ms, plus a sub-range strictly inside that day.
const JUN1 = '2026-06-01';
const JUN2 = '2026-06-02';
const jun1Range = { start: Date.UTC(2026, 5, 1, 1), end: Date.UTC(2026, 5, 1, 2) };
const twoDayRange = { start: Date.UTC(2026, 5, 1, 0), end: Date.UTC(2026, 5, 2, 12) };

describe('useTimelineEvents — refreshVisible', () => {
  beforeEach(async () => {
    (await mockedApi()).getEvents.mockReset();
  });

  it('re-fetches an already-cached date and replaces its events', async () => {
    const api = await mockedApi();
    let calls = 0;
    api.getEvents.mockImplementation(async () => {
      calls += 1;
      // First (initial) fetch: one event. Second (refresh): a new clip appeared.
      return { events: calls === 1 ? [{ id: 'a' }] : [{ id: 'a' }, { id: 'b' }] };
    });

    const { result } = renderHook(() => useTimelineEvents([]));

    await act(async () => {
      await result.current.ensureDatesFetched(jun1Range.start, jun1Range.end);
    });
    await waitFor(() => expect(result.current.eventsByDate[JUN1]).toHaveLength(1));

    await act(async () => {
      await result.current.refreshVisible(jun1Range.start, jun1Range.end);
    });

    await waitFor(() => expect(result.current.eventsByDate[JUN1]).toHaveLength(2));
    // The whole point: refresh bypasses the per-date fetched cache and hits the net again.
    expect(api.getEvents).toHaveBeenCalledTimes(2);
  });

  it('leaves cached dates outside the refreshed range untouched (by reference)', async () => {
    const api = await mockedApi();
    api.getEvents.mockImplementation(async (params: { dateFrom: string }) => ({
      events: [{ id: `${params.dateFrom}-x` }],
    }));

    const { result } = renderHook(() => useTimelineEvents([]));

    await act(async () => {
      await result.current.ensureDatesFetched(twoDayRange.start, twoDayRange.end);
    });
    await waitFor(() => {
      expect(result.current.eventsByDate[JUN1]).toBeDefined();
      expect(result.current.eventsByDate[JUN2]).toBeDefined();
    });
    const jun2Before = result.current.eventsByDate[JUN2];

    await act(async () => {
      await result.current.refreshVisible(jun1Range.start, jun1Range.end);
    });
    await waitFor(() => expect(api.getEvents).toHaveBeenCalledTimes(3)); // 2 initial + 1 refresh

    // The untouched day keeps the exact same array instance — no blank, no churn.
    expect(result.current.eventsByDate[JUN2]).toBe(jun2Before);
  });

  it('keeps the stale cached day when a refresh fetch fails (no blanking)', async () => {
    const api = await mockedApi();
    let calls = 0;
    api.getEvents.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { events: [{ id: 'a' }] };
      throw new Error('network down');
    });

    const { result } = renderHook(() => useTimelineEvents([]));
    await act(async () => {
      await result.current.ensureDatesFetched(jun1Range.start, jun1Range.end);
    });
    await waitFor(() => expect(result.current.eventsByDate[JUN1]).toHaveLength(1));

    await act(async () => {
      await result.current.refreshVisible(jun1Range.start, jun1Range.end);
    });

    // Failed refresh must not wipe the day to [].
    expect(result.current.eventsByDate[JUN1]).toHaveLength(1);
  });

  it('does not flip the loading flag (silent background refresh)', async () => {
    const api = await mockedApi();
    api.getEvents.mockResolvedValue({ events: [] });

    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const h = useTimelineEvents([]);
      seen.push(h.loading);
      return h;
    });

    await act(async () => {
      await result.current.ensureDatesFetched(jun1Range.start, jun1Range.end);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    seen.length = 0; // discard the initial (non-silent) fetch's transitions
    await act(async () => {
      await result.current.refreshVisible(jun1Range.start, jun1Range.end);
    });

    expect(seen.every((v) => v === false)).toBe(true);
  });
});

describe('shouldAutoRefresh', () => {
  it('skips when the tab is hidden', () => {
    expect(shouldAutoRefresh({ hidden: true, msSinceInteraction: 10_000 })).toBe(false);
  });

  it('skips while the user is actively interacting', () => {
    expect(shouldAutoRefresh({ hidden: false, msSinceInteraction: 500 })).toBe(false);
  });

  it('refreshes when visible and idle past the threshold', () => {
    expect(shouldAutoRefresh({ hidden: false, msSinceInteraction: 5_000 })).toBe(true);
  });

  it('honors a custom idle threshold', () => {
    expect(shouldAutoRefresh({ hidden: false, msSinceInteraction: 1_500, idleThresholdMs: 3_000 })).toBe(false);
    expect(shouldAutoRefresh({ hidden: false, msSinceInteraction: 3_500, idleThresholdMs: 3_000 })).toBe(true);
  });
});
