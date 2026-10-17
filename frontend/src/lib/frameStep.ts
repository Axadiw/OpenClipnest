/**
 * Compute the target currentTime for a one-frame step.
 *
 * Reolink streams are variable-frame-rate, so we walk the real presentation-time
 * `grid` (seconds, sorted ascending) when it's available: find the grid frame
 * nearest the current time and move one index in `dir`. When the grid is empty
 * (not yet fetched, endpoint absent, or older recording) we fall back to the
 * fixed-fps approximation `currentTime + dir/fps`, clamped to the clip.
 */
export function stepOnGrid(
  grid: number[],
  currentTime: number,
  dir: 1 | -1,
  fps: number,
  duration: number,
): number {
  if (grid.length > 0) {
    let nearest = 0;
    let best = Infinity;
    for (let k = 0; k < grid.length; k++) {
      const d = Math.abs(grid[k] - currentTime);
      if (d < best) { best = d; nearest = k; }
    }
    const target = Math.min(Math.max(nearest + dir, 0), grid.length - 1);
    return grid[target];
  }
  // No grid AND no trustworthy duration (0/negative/NaN): don't move — the
  // fps fallback needs real bounds. Blocks both step buttons until metadata
  // loads, never returns a negative time. This exact guard shape is shared by
  // all four ports (web / iOS / Android / Windows) — keep them in sync.
  if (!(duration > 0)) return Math.max(0, currentTime);
  const safeFps = fps > 0 ? fps : 30;
  const t = currentTime + dir / safeFps;
  return Math.min(Math.max(0, t), duration);
}

/** Seconds below which a step target counts as "didn't move" — well under any
 *  real frame interval (even 240fps is ~4.2ms). */
const STEP_EPSILON = 1e-3;

/**
 * Whether a one-frame step in `dir` would actually move the playhead in that
 * direction. Mirrors {@link stepOnGrid} exactly: the button should be
 * disabled when the computed target clamps back onto the current position
 * (first/last grid frame, or the [0, duration] fallback bounds) — including
 * the played-to-the-end case where currentTime sits past the last frame's
 * presentation time and a forward step would only snap backwards onto it.
 */
export function canStep(
  grid: number[],
  currentTime: number,
  dir: 1 | -1,
  fps: number,
  duration: number,
): boolean {
  if (!Number.isFinite(currentTime)) return false;
  const target = stepOnGrid(grid, currentTime, dir, fps, duration);
  if (!Number.isFinite(target)) return false;
  return dir === 1 ? target > currentTime + STEP_EPSILON : target < currentTime - STEP_EPSILON;
}
