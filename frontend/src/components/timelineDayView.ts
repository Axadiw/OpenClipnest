// Pure helpers for framing the timeline on a single day.
//
// All day-aligned timeline machinery is UTC: event timestamps are stored as
// `HH:MM:SSZ` (camera wall clock relabelled as UTC), `getDatesInRange` buckets
// /fetches events by UTC date, and the axis ticks + day-boundary lines use
// `setUTCHours`. So a "full day" window must be [UTC-midnight, +24h) — that
// exactly equals one UTC date bucket, so every recording of the day fits and
// the day-boundary line sits flush at the right edge. Using *local* midnight
// (the old behaviour) shifted the window by the browser's TZ offset and clipped
// the last offset-hours of the day in non-UTC zones.

const DAY_MS = 24 * 3600_000;

export interface DayView {
  viewStart: number;
  viewEnd: number;
}

/** Full UTC-day window [00:00Z, next 00:00Z) for the calendar day that the
 *  instant `ts` (epoch ms) falls in. Use for an event timestamp. */
export function dayViewForTimestamp(ts: number): DayView {
  const start = new Date(ts);
  start.setUTCHours(0, 0, 0, 0);
  const viewStart = start.getTime();
  return { viewStart, viewEnd: viewStart + DAY_MS };
}

/** Full UTC-day window [00:00Z, next 00:00Z) for a calendar date labelled
 *  `YYYY-MM-DD`. Use for the `?date=` param and the calendar date pick. */
export function dayViewForDateStr(dateStr: string): DayView {
  const viewStart = new Date(dateStr + 'T00:00:00Z').getTime();
  return { viewStart, viewEnd: viewStart + DAY_MS };
}
