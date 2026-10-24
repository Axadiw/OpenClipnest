// @vitest-environment node
// @ts-expect-error the web package has no @types/node; vitest runs this file under node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSampleIndex, probeLayout, windowBytes } from '../mp4/sampleTable';
import { cachedFractionSegments, usableCachedRanges } from './cachedSegments';

const fast = new Uint8Array(readFileSync(new URL('../mp4/__fixtures__/faststart-3s.mp4', import.meta.url)));
const layout = probeLayout(fast);
if (layout.kind !== 'faststart') throw new Error('fixture is not faststart');
const ix = parseSampleIndex(fast.subarray(layout.moovStart, layout.moovEnd), layout.moovStart)!;

describe('cachedFractionSegments', () => {
  it('maps a cached window to a fraction of the duration', () => {
    const segs = cachedFractionSegments(ix, [windowBytes(ix, 2.0, 0.9)], 3);
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBeCloseTo(2 / 3, 2);
    expect(segs[0].end).toBeGreaterThan(segs[0].start);
    expect(segs[0].end).toBeLessThanOrEqual(1);
  });
  it('keeps separate stretches separate', () => {
    const segs = cachedFractionSegments(ix, [windowBytes(ix, 0, 0.9), windowBytes(ix, 2.0, 0.9)], 3);
    expect(segs).toHaveLength(2);
  });
  it('is empty without an index, without cached bytes or with an unusable duration', () => {
    expect(cachedFractionSegments(null, [windowBytes(ix, 2.0, 0.9)], 3)).toEqual([]);
    expect(cachedFractionSegments(ix, [], 3)).toEqual([]);
    expect(cachedFractionSegments(ix, [windowBytes(ix, 2.0, 0.9)], 0)).toEqual([]);
    expect(cachedFractionSegments(ix, [windowBytes(ix, 2.0, 0.9)], NaN)).toEqual([]);
  });
});

describe('usableCachedRanges', () => {
  const r = [{ start: 0, end: 50 }, { start: 90, end: 200 }, { start: 300, end: 400 }];
  it('is empty when the totals differ or are unknown', () => {
    expect(usableCachedRanges(r, 100, 120)).toEqual([]);
    expect(usableCachedRanges(r, 0, 0)).toEqual([]);
    expect(usableCachedRanges(r, 100, 0)).toEqual([]);
  });
  it('clips to the file and drops ranges past it', () => {
    expect(usableCachedRanges(r, 100, 100)).toEqual([{ start: 0, end: 50 }, { start: 90, end: 100 }]);
  });
});
