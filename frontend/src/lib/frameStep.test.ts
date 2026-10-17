import { describe, it, expect } from 'vitest';
import { canStep, stepOnGrid } from './frameStep';

describe('stepOnGrid', () => {
  const grid = [0, 0.067, 0.2, 0.267]; // irregular VFR grid

  it('steps to the previous/next grid frame from an exact frame time', () => {
    expect(stepOnGrid(grid, 0.2, -1, 15, 10)).toBeCloseTo(0.067, 6);
    expect(stepOnGrid(grid, 0.2, 1, 15, 10)).toBeCloseTo(0.267, 6);
  });

  it('snaps to the nearest grid index when currentTime is between frames', () => {
    // 0.19 is nearest to 0.2 (index 2); step -1 -> 0.067
    expect(stepOnGrid(grid, 0.19, -1, 15, 10)).toBeCloseTo(0.067, 6);
  });

  it('clamps at the grid ends', () => {
    expect(stepOnGrid(grid, 0, -1, 15, 10)).toBeCloseTo(0, 6);          // already first
    expect(stepOnGrid(grid, 0.267, 1, 15, 10)).toBeCloseTo(0.267, 6);   // already last
  });

  it('falls back to currentTime + dir/fps when the grid is empty', () => {
    expect(stepOnGrid([], 1, 1, 15, 10)).toBeCloseTo(1 + 1 / 15, 6);
    expect(stepOnGrid([], 1, -1, 15, 10)).toBeCloseTo(1 - 1 / 15, 6);
  });

  it('fallback uses 30fps when fps is missing/0, and clamps to [0, duration]', () => {
    expect(stepOnGrid([], 1, 1, 0, 10)).toBeCloseTo(1 + 1 / 30, 6);
    expect(stepOnGrid([], 0, -1, 30, 10)).toBe(0);          // clamp low
    expect(stepOnGrid([], 10, 1, 30, 10)).toBe(10);         // clamp to duration
  });
});

describe('canStep', () => {
  const grid = [0, 0.067, 0.2, 0.267]; // irregular VFR grid

  it('allows both directions mid-video on the grid', () => {
    expect(canStep(grid, 0.2, -1, 15, 10)).toBe(true);
    expect(canStep(grid, 0.2, 1, 15, 10)).toBe(true);
  });

  it('blocks step-back on the first grid frame', () => {
    expect(canStep(grid, 0, -1, 15, 10)).toBe(false);
    expect(canStep(grid, 0, 1, 15, 10)).toBe(true);
  });

  it('blocks step-forward on the last grid frame even though duration is larger', () => {
    // last frame presents at 0.267 while the clip reports duration 10 —
    // a naive currentTime >= duration check would keep the button enabled.
    expect(canStep(grid, 0.267, 1, 15, 10)).toBe(false);
    expect(canStep(grid, 0.267, -1, 15, 10)).toBe(true);
  });

  it('blocks step-forward when currentTime sits between the last two frames but nearest the last', () => {
    expect(canStep(grid, 0.29, 1, 15, 10)).toBe(false);
  });

  it('blocks step-forward after playing to the end (currentTime past the last frame)', () => {
    // ended clip: currentTime == duration, well past the last presentation
    // time; a forward step would only snap backwards onto the last frame.
    expect(canStep(grid, 10, 1, 15, 10)).toBe(false);
    expect(canStep(grid, 10, -1, 15, 10)).toBe(true);
  });

  it('fps fallback: allows both directions mid-video, blocks at the clip bounds', () => {
    expect(canStep([], 1, -1, 15, 10)).toBe(true);
    expect(canStep([], 1, 1, 15, 10)).toBe(true);
    expect(canStep([], 0, -1, 15, 10)).toBe(false);
    expect(canStep([], 10, 1, 15, 10)).toBe(false);
  });

  it('fps fallback: uses 30fps when fps is missing/0', () => {
    expect(canStep([], 1, 1, 0, 10)).toBe(true);
    expect(canStep([], 10 - 0.5 / 30, 1, 0, 10)).toBe(true); // half a 30fps frame still moves
  });

  it('blocks steps when duration is 0 or NaN and there is no grid', () => {
    expect(canStep([], 0, 1, 30, 0)).toBe(false);
    expect(canStep([], 0, -1, 30, 0)).toBe(false);
    expect(canStep([], 1, 1, 30, NaN)).toBe(false);
    expect(canStep([], 1, -1, 30, NaN)).toBe(false);
  });

  it('back-step from zero with unknown duration must not throw and never targets a negative time', () => {
    // Cross-platform regression: the Android port crashed here
    // (empty coerceIn range) and iOS/Windows returned a NEGATIVE target that
    // enabled a back-step button seeking to -1/30s. Canonical semantics: no
    // grid + no trustworthy duration → target stays put, never below 0.
    expect(stepOnGrid([], 0, -1, 30, 0)).toBe(0);
    expect(stepOnGrid([], -1, -1, 30, -1)).toBe(0); // defensive: negative inputs
  });

  it('blocks steps when currentTime is not finite', () => {
    expect(canStep(grid, NaN, 1, 15, 10)).toBe(false);
    expect(canStep([], NaN, 1, 15, 10)).toBe(false);
  });
});
