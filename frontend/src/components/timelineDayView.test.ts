import { describe, test, expect } from 'vitest';
import { dayViewForTimestamp, dayViewForDateStr } from './timelineDayView';

const DAY_MS = 24 * 3600_000;

describe('dayViewForTimestamp', () => {
  test('frames the full UTC day containing the instant', () => {
    const { viewStart, viewEnd } = dayViewForTimestamp(Date.parse('2026-06-04T14:30:00Z'));
    expect(viewStart).toBe(Date.parse('2026-06-04T00:00:00Z'));
    expect(viewEnd).toBe(Date.parse('2026-06-05T00:00:00Z'));
  });

  test('a 23:00 timestamp still maps to the same UTC day (no TZ clipping)', () => {
    const ts = Date.parse('2026-06-04T23:00:00Z');
    const { viewStart, viewEnd } = dayViewForTimestamp(ts);
    expect(viewStart).toBe(Date.parse('2026-06-04T00:00:00Z'));
    expect(viewEnd).toBe(Date.parse('2026-06-05T00:00:00Z'));
    // the event lies strictly inside [viewStart, viewEnd)
    expect(ts).toBeGreaterThanOrEqual(viewStart);
    expect(ts).toBeLessThan(viewEnd);
  });

  test('window is exactly 24h', () => {
    const { viewStart, viewEnd } = dayViewForTimestamp(Date.parse('2026-01-15T08:00:00Z'));
    expect(viewEnd - viewStart).toBe(DAY_MS);
  });
});

describe('dayViewForDateStr', () => {
  test('frames UTC midnight of the labelled day to +24h', () => {
    const { viewStart, viewEnd } = dayViewForDateStr('2026-06-04');
    expect(viewStart).toBe(Date.parse('2026-06-04T00:00:00Z'));
    expect(viewEnd).toBe(Date.parse('2026-06-05T00:00:00Z'));
    expect(viewEnd - viewStart).toBe(DAY_MS);
  });
});
