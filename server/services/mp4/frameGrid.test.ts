import { describe, it, expect } from 'vitest';
import { buildFrameGrid, type GridSample } from './frameGrid.js';

describe('buildFrameGrid', () => {
  it('returns presentation times in seconds, sorted ascending', () => {
    // timescale 90000; durations 6000,6000,6000 -> DTS 0,6000,12000
    // composition offsets reorder (B-frame style)
    const samples: GridSample[] = [
      { durationTicks: 6000, compositionOffset: 6000 },
      { durationTicks: 6000, compositionOffset: -6000 },
      { durationTicks: 6000, compositionOffset: 6000 },
    ];
    const grid = buildFrameGrid(samples, 90000);
    // PTS ticks: s0=0+6000=6000, s1=6000-6000=0, s2=12000+6000=18000 -> sorted 0,6000,18000
    expect(grid).toEqual([0, 6000 / 90000, 18000 / 90000]);
  });

  it('handles VFR (uneven durations) and zero composition offsets', () => {
    const samples: GridSample[] = [
      { durationTicks: 6000, compositionOffset: 0 },
      { durationTicks: 12000, compositionOffset: 0 },
      { durationTicks: 6000, compositionOffset: 0 },
    ];
    const grid = buildFrameGrid(samples, 90000);
    expect(grid).toEqual([0, 6000 / 90000, 18000 / 90000]);
  });

  it('returns [] for no samples', () => {
    expect(buildFrameGrid([], 90000)).toEqual([]);
  });

  it('returns [] for non-positive timescale', () => {
    expect(buildFrameGrid([{ durationTicks: 6000, compositionOffset: 0 }], 0)).toEqual([]);
  });
});
