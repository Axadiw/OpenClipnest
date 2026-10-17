import { describe, it, expect } from 'vitest';
import { formatClock, clamp01, pointerFraction, bufferedEndFraction } from './videoControls';

describe('formatClock', () => {
  it('formats whole seconds as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(4)).toBe('0:04');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(125)).toBe('2:05');
    expect(formatClock(600)).toBe('10:00');
  });

  it('floors fractional seconds', () => {
    expect(formatClock(4.9)).toBe('0:04');
    expect(formatClock(59.999)).toBe('0:59');
  });

  it('returns 0:00 for non-finite or negative input', () => {
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('clamp01', () => {
  it('clamps to the [0,1] range', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});

describe('pointerFraction', () => {
  it('maps a pointer x to a 0..1 fraction of the track width', () => {
    expect(pointerFraction(50, { left: 0, width: 100 })).toBe(0.5);
    expect(pointerFraction(0, { left: 0, width: 100 })).toBe(0);
    expect(pointerFraction(100, { left: 0, width: 100 })).toBe(1);
  });

  it('accounts for the track left offset', () => {
    expect(pointerFraction(120, { left: 20, width: 100 })).toBe(1);
    expect(pointerFraction(70, { left: 20, width: 100 })).toBeCloseTo(0.5, 6);
  });

  it('clamps out-of-bounds pointers and guards a zero-width track', () => {
    expect(pointerFraction(-10, { left: 0, width: 100 })).toBe(0);
    expect(pointerFraction(999, { left: 0, width: 100 })).toBe(1);
    expect(pointerFraction(50, { left: 0, width: 0 })).toBe(0);
  });
});

describe('bufferedEndFraction', () => {
  const ranges = (...ends: number[]) => ({
    length: ends.length,
    start: () => 0,
    end: (i: number) => ends[i],
  }) as unknown as TimeRanges;

  it('returns the furthest buffered end as a fraction of duration', () => {
    expect(bufferedEndFraction(ranges(2, 5), 10)).toBe(0.5);
    expect(bufferedEndFraction(ranges(10), 10)).toBe(1);
  });

  it('clamps when the buffered end exceeds duration', () => {
    expect(bufferedEndFraction(ranges(12), 10)).toBe(1);
  });

  it('returns 0 when there are no ranges or duration is invalid', () => {
    expect(bufferedEndFraction(ranges(), 10)).toBe(0);
    expect(bufferedEndFraction(null, 10)).toBe(0);
    expect(bufferedEndFraction(ranges(5), 0)).toBe(0);
    expect(bufferedEndFraction(ranges(5), NaN)).toBe(0);
  });
});
