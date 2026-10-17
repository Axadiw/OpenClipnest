export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || isNaN(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format a whole number of seconds as a stopwatch-style `M:SS` (minutes
 * unpadded, seconds zero-padded): 42 → "0:42", 65 → "1:05", 600 → "10:00".
 * Shared by the event-card clip duration and the rate-limit countdown notice.
 */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

// Event timestamps carry the camera's LOCAL wall-clock baked into the
// filename (YYYYMMDDhhmmss). The server parses those digits as if they were
// UTC, so the ISO string stored in DB reads e.g. "2026-04-24T09:25:00.000Z"
// for a real 09:25 camera clock. Displaying that with the browser's local
// time zone reintroduces the offset (09:25Z → 11:25 for CEST). Treat the
// stamp as opaque wall-clock and format in UTC — that's what users recognize
// from the footage itself.
//
// Use these helpers for anything whose source is a `CameraEvent.timestamp`.
// `notifications.createdAt` and similar server clocks are real wall-clock
// UTC and should use the normal locale-aware formatters.

// Constructing `new Intl.DateTimeFormat(...)` is ~50-200µs per call. The grid
// renders these helpers ~50 cards × N rerenders/s; without caching that's
// thousands of allocations per second and one of the dominant CPU costs the
// 2026-05-15 flame chart caught. Module-level Map keyed on locale + opts JSON
// makes every call after the first an O(1) lookup. `Intl.DateTimeFormat`
// instances are stateless across `.format()` calls so sharing is safe.
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function getDTF(locale: string | string[], opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = (Array.isArray(locale) ? locale.join(',') : locale) + '|' + JSON.stringify(opts);
  let fmt = dtfCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, opts);
    dtfCache.set(key, fmt);
  }
  return fmt;
}

// `toLocaleString` and `Intl.DateTimeFormat` look interchangeable but
// differ in their option defaults: `toLocaleString` runs
// `ToDateTimeOptions(opts, 'any', 'all')` (defaults to date+time when no
// field is set), while `new Intl.DateTimeFormat(opts)` runs
// `ToDateTimeOptions(opts, 'any', 'date')` (date-only default). Spelling
// out year/month/day + hour/minute/second below preserves the previous
// output exactly across this cache refactor.
const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  timeZone: 'UTC',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric',
};
const DATE_OPTS: Intl.DateTimeFormatOptions = {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
};
const TIME_OPTS_DEFAULT: Intl.DateTimeFormatOptions = {
  hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
};

export function formatEventDateTime(iso: string, locale = 'default'): string {
  return getDTF(locale, DATETIME_OPTS).format(new Date(iso));
}

export function formatEventTime(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  const effective = opts ? { ...opts, timeZone: 'UTC' } : TIME_OPTS_DEFAULT;
  return getDTF([], effective).format(new Date(iso));
}

export function formatEventDate(iso: string, locale = 'default'): string {
  return getDTF(locale, DATE_OPTS).format(new Date(iso));
}

/**
 * Reinterpret the event's UTC-stored wall-clock as a LOCAL Date so date-fns
 * grouping helpers (isToday / isYesterday / format) read it the same way a
 * human reads the digits on the camera footage. Use this ONLY for those
 * day-bucketing / locale-formatted-day-name calls.
 *
 * NEVER feed the result into `formatDistanceToNow` or any other duration
 * math — the reconstructed Date's epoch is shifted by the user's TZ
 * offset, so distance-to-`Date.now()` comes out wrong by that offset
 * (e.g. CEST viewer sees a 9-min-old event as "about 2 hours ago"). For
 * "X ago" math, pass `new Date(iso)` directly (three call sites tripped on
 * this).
 */
export function eventDateAsLocal(iso: string): Date {
  const d = new Date(iso);
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  );
}

/**
 * Return a Date suitable for feeding into `formatDistanceToNow` when the
 * event timestamp is stored as wall-clock-baked-as-UTC (see block comment
 * above). Subtracts the camera timezone's UTC offset so the resulting epoch
 * reflects actual UTC, making distance-to-now calculations correct.
 *
 * Example: camera wall-clock "12:45" in Europe/Warsaw (UTC+2) is stored as
 * "12:45Z". Actual UTC is 10:45. This function returns that 10:45 UTC Date.
 */
export function forRelativeTime(iso: string, cameraTimezone = 'UTC'): Date {
  const wallClock = new Date(iso);
  if (cameraTimezone === 'UTC') return wallClock;
  try {
    return new Date(wallClock.getTime() - tzOffsetMs(wallClock.getTime(), cameraTimezone));
  } catch {
    return wallClock;
  }
}

/**
 * UTC offset of `tz` at `instantMs`, in ms (positive east of Greenwich).
 * DST-aware — the offset is resolved for that specific instant, so a helper
 * built on it doesn't drift by an hour twice a year.
 *
 * Was inlined in `forRelativeTime`, which constructed a fresh
 * `Intl.DateTimeFormat` on every call. That ran ~50 cards × dozens of
 * re-renders/s in the grid on prod and showed up as 22% main-thread CPU in
 * the 2026-05-15 flame chart, hence `getDTF`. Caching is safe because the
 * formatter only depends on `tz`.
 *
 * `hourCycle: 'h23'` is load-bearing, NOT style. `hour12: false` leaves the
 * hour cycle to the locale, and en-US resolves it differently per ICU
 * version: Node 20 (what CI runs) gives **h24**, Node 22 gives h23. Under
 * h24 midnight formats as hour `24` on the ALREADY-ROLLED-OVER date, so
 * `Date.UTC(…, 24, 30)` lands a full day late and this returns offset+24h.
 * That is a real user-facing bug for the whole 00:00 hour in the account
 * zone — the timeline's now-line, the default "today" date and every "X
 * ago" label jump a day — and it is browser-ICU-dependent, so it would have
 * shipped as "works on my machine". Caught by CI on 2026-07-31:
 * `wallClockDayStr(22:30Z, 'Europe/Warsaw')` returned 2026-08-02, not
 * 2026-08-01. The `% 24` is belt-and-braces for any engine that ignores
 * `hourCycle`; h24 reports the correct DATE, only the hour is 24-not-0.
 */
function tzOffsetMs(instantMs: number, tz: string): number {
  const fmt = getDTF('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return asUtc - instantMs;
}

/**
 * Real `now` (epoch ms) expressed as the wall clock in `accountTimezone` and
 * relabelled as UTC, so it lands on the SAME axis as wall-clock-baked event
 * timestamps. The inverse of `forRelativeTime`.
 *
 * Anything drawn against event timestamps — the timeline's now-line, a
 * "today" boundary, a future-date guard — must go through this. Feeding raw
 * `Date.now()` into that axis puts the marker `offset` hours away from the
 * clips it's supposed to sit beside: the 2026-07-31 report of the green
 * now-line standing two hours left of the newest recordings in Europe/Warsaw.
 *
 * Example: 10:00 UTC with a Europe/Warsaw account (+2 in summer) → 12:00Z,
 * i.e. the wall clock a camera there is stamping right now.
 *
 * Mirrors `EventClock.nowWallClock` on iOS/Android and `EventClock.NowWallClock`
 * on Windows — keep the four in step.
 */
export function nowWallClock(nowMs: number, accountTimezone = 'UTC'): number {
  if (accountTimezone === 'UTC') return nowMs;
  try {
    return nowMs + tzOffsetMs(nowMs, accountTimezone);
  } catch {
    return nowMs;
  }
}

/**
 * `now` as the account-zone wall-clock day in `YYYY-MM-DD` — the date key the
 * timeline's `?date=` param and the event buckets use. Built on `nowWallClock`
 * so it lands on the same day a clip's baked stamp does, never the browser's.
 *
 * Example: 22:30 UTC with a Europe/Warsaw account is already 00:30 the next
 * day, so this rolls over while the browser's local date may not have.
 */
export function wallClockDayStr(nowMs: number, accountTimezone = 'UTC'): string {
  return new Date(nowWallClock(nowMs, accountTimezone)).toISOString().slice(0, 10);
}

/**
 * Pick the view id to play given a URL-requested choice and the actual
 * view files attached to the loaded event. Notification deep-links carry
 * a profile-defined string ('00'/'01' for Reolink, anything for custom
 * profiles). If that view id is missing from the event (e.g. an autoDelete
 * removed the partner), fall back to the primary (first) attached view
 * to avoid a 404 on `/video/:viewId`. Returns null when the event has no
 * playable view — caller renders an empty state.
 */
export function resolveView(
  requested: string,
  event: { views: Array<{ id: string }> },
): string | null {
  if (event.views.some(l => l.id === requested)) return requested;
  return event.views[0]?.id ?? null;
}
