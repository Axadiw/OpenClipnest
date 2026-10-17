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

/**
 * Fraction of `duration` covered by the furthest buffered range end — used
 * to paint the "buffered" portion of the seek bar. Returns 0 when there are
 * no ranges or the duration isn't a usable positive number.
 */
export function bufferedEndFraction(buffered: TimeRanges | null | undefined, duration: number): number {
  if (!buffered || buffered.length === 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const end = buffered.end(buffered.length - 1);
  return clamp01(end / duration);
}
