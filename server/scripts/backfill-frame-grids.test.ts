import { describe, it, expect } from 'vitest';
import { nextCursor, frameGridAction } from './backfill-frame-grids.js';

describe('nextCursor', () => {
  it('returns null for an empty batch', () => {
    expect(nextCursor([])).toBeNull();
  });

  it('returns the last row as the cursor', () => {
    const rows = [
      { eventId: 'a', viewId: '00' },
      { eventId: 'b', viewId: '01' },
    ];
    expect(nextCursor(rows)).toEqual({ eventId: 'b', viewId: '01' });
  });

  it('works for a single-row batch', () => {
    const rows = [{ eventId: 'x', viewId: '00' }];
    expect(nextCursor(rows)).toEqual({ eventId: 'x', viewId: '00' });
  });
});

describe('frameGridAction', () => {
  it('returns skip when sidecar already exists', () => {
    expect(frameGridAction(true)).toBe('skip');
  });

  it('returns generate when sidecar is absent', () => {
    expect(frameGridAction(false)).toBe('generate');
  });
});
