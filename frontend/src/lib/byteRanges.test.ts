import { describe, expect, it } from 'vitest';
import { covers, subtract, totalBytes, union } from './byteRanges';

describe('byteRanges', () => {
  it('unions and merges touching ranges', () => {
    expect(union([{ start: 0, end: 10 }], [{ start: 10, end: 20 }, { start: 30, end: 40 }])).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });
  it('subtracts', () => {
    expect(subtract([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 50, end: 60 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 50 },
      { start: 60, end: 100 },
    ]);
    expect(subtract([{ start: 0, end: 10 }], [{ start: 0, end: 10 }])).toEqual([]);
  });
  it('covers', () => {
    expect(covers([{ start: 0, end: 10 }, { start: 20, end: 30 }], { start: 5, end: 25 })).toBe(false);
    expect(covers([{ start: 0, end: 30 }], { start: 5, end: 25 })).toBe(true);
  });
  it('totals bytes', () => {
    expect(totalBytes(union([{ start: 0, end: 5 }], [{ start: 3, end: 8 }]))).toBe(8);
  });
  it('does not mutate inputs', () => {
    const a = [{ start: 5, end: 9 }, { start: 0, end: 6 }];
    union(a, []);
    expect(a).toEqual([{ start: 5, end: 9 }, { start: 0, end: 6 }]);
  });
});
