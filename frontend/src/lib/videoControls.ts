// Pure helpers for the custom <video> control bar (VideoControls.tsx).
// Kept free of React/DOM so the seek math + formatting can be unit-tested
// in isolation.

/** Clamp a number into the [0, 1] range. */
export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Format a time in seconds as `m:ss`. Non-finite / negative → `0:00`. */
export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Map a pointer's clientX to a 0..1 fraction along a track. Clamped to the
 * track bounds; a zero-width track yields 0 (avoids divide-by-zero).
 */
export function pointerFraction(clientX: number, rect: { left: number; width: number }): number {
  if (rect.width <= 0) return 0;
  return clamp01((clientX - rect.left) / rect.width);
}

/** A span of the timeline as fractions (0..1) of the duration. */
export interface Segment { start: number; end: number }

/**
 * Sort segments and union the overlapping or touching ones; empty segments
 * are dropped.
 */
export function mergeSegments(segs: Segment[]): Segment[] {
  const sorted = segs.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/**
 * One segment per buffered range, as fractions of `duration`, clamped to
 * [0,1] — paints the grey "buffered" parts of the seek bar, gaps included.
 * Returns [] when there are no ranges or the duration isn't usable.
 */
export function bufferedSegments(buffered: TimeRanges | null | undefined, duration: number): Segment[] {
  if (!buffered || buffered.length === 0) return [];
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const segs: Segment[] = [];
  for (let i = 0; i < buffered.length; i++) {
    const start = clamp01(buffered.start(i) / duration);
    const end = clamp01(buffered.end(i) / duration);
    if (end > start) segs.push({ start, end });
  }
  return segs;
}
