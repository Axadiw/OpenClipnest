import { describe, it, expect } from 'vitest';
import { RangeCache } from './rangeCache';

function bytes(start: number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (start + i) & 0xff;
  return b;
}

describe('RangeCache', () => {
  it('each cache instance (worker boot) has its own epoch', () => {
    expect(new RangeCache().epoch).not.toBe(new RangeCache().epoch);
  });

  it('snapshot reports total and ranges, and is empty for an unknown key', () => {
    const c = new RangeCache();
    expect(c.snapshot('k')).toEqual({ total: 0, ranges: [], seq: 0, epoch: c.epoch });
    c.setMeta('k', 100, 'video/mp4');
    c.put('k', 10, bytes(10, 20));
    const first = c.snapshot('k');
    expect(first).toMatchObject({ total: 100, ranges: [{ start: 10, end: 30 }] });
    c.put('k', 40, bytes(40, 5));
    expect(c.snapshot('k').seq).toBeGreaterThan(first.seq);
    c.drop('k');
    expect(c.snapshot('k').seq).toBeGreaterThan(first.seq);
  });

  it('read returns null until fully covered', () => {
    const c = new RangeCache();
    c.setMeta('k', 100, 'video/mp4');
    c.put('k', 0, bytes(0, 40));
    expect(c.read('k', 0, 50)).toBeNull();
    expect(c.read('k', 0, 40)).toEqual(bytes(0, 40));
    c.put('k', 40, bytes(40, 10));
    expect(c.read('k', 0, 50)).toEqual(bytes(0, 50));
    expect(c.read('missing', 0, 1)).toBeNull();
  });

  it('put of overlapping pieces then read across them returns the exact bytes', () => {
    const c = new RangeCache();
    c.setMeta('k', 100, 'video/mp4');
    c.put('k', 10, bytes(10, 30));
    c.put('k', 0, bytes(0, 20));
    c.put('k', 35, bytes(35, 30));
    c.put('k', 12, bytes(12, 5));
    expect(c.ranges('k')).toEqual([{ start: 0, end: 65 }]);
    expect(c.read('k', 5, 60)).toEqual(bytes(5, 55));
    expect(c.contiguousFrom('k', 5, 1000)).toBe(60);
    expect(c.contiguousFrom('k', 5, 7)).toBe(7);
    expect(c.contiguousFrom('k', 65, 10)).toBe(0);
    expect(c.size()).toBe(65);
  });

  it('rangeCache drops entry on total mismatch', () => {
    const c = new RangeCache();
    expect(c.setMeta('k', 100, 'video/mp4')).toBe('ok');
    c.put('k', 0, bytes(0, 10));
    expect(c.setMeta('k', 100, 'video/mp4')).toBe('ok');
    expect(c.ranges('k')).toEqual([{ start: 0, end: 10 }]);
    expect(c.setMeta('k', 120, 'video/mp4')).toBe('reset');
    expect(c.ranges('k')).toEqual([]);
    expect(c.meta('k')).toEqual({ total: 120, contentType: 'video/mp4' });
  });

  it('evicts least-recently-read pieces past maxBytes', () => {
    const c = new RangeCache(1000);
    c.setMeta('a', 5000, 'video/mp4');
    c.setMeta('b', 5000, 'video/mp4');
    c.put('a', 0, bytes(0, 400));
    c.put('b', 0, bytes(0, 400));
    c.put('a', 1000, bytes(1000, 400));
    expect(c.size()).toBeLessThanOrEqual(1000);
    expect(c.ranges('a')).toEqual([{ start: 1000, end: 1400 }]);
    expect(c.ranges('b')).toEqual([{ start: 0, end: 400 }]);
  });

  it('a read refreshes recency and protects a piece for 2 s', () => {
    let now = 0;
    const c = new RangeCache(1000, () => now);
    c.setMeta('k', 5000, 'video/mp4');
    c.put('k', 0, bytes(0, 400));
    c.put('k', 1000, bytes(1000, 400));
    c.read('k', 0, 10); // piece 0 now most recently used AND read just now
    now = 500;
    c.put('k', 2000, bytes(2000, 400));
    // piece 1000 is the LRU one
    expect(c.ranges('k')).toEqual([{ start: 0, end: 400 }, { start: 2000, end: 2400 }]);
    // everything read within 2 s survives even past the cap
    c.read('k', 0, 10);
    c.read('k', 2000, 2010);
    c.put('k', 3000, bytes(3000, 400));
    expect(c.ranges('k')).toEqual([{ start: 0, end: 400 }, { start: 2000, end: 2400 }]);
    now = 5000;
    c.put('k', 4000, bytes(4000, 400));
    expect(c.size()).toBeLessThanOrEqual(1000);
  });

  it('put with a stale stamp is a no-op', () => {
    const c = new RangeCache();
    c.setMeta('k', 100, 'video/mp4');
    const s = c.stamp('k');
    c.put('k', 0, bytes(0, 10), s);
    expect(c.size()).toBe(10);
    c.setMeta('k', 120, 'video/mp4'); // reset
    c.put('k', 10, bytes(10, 10), s);
    expect(c.ranges('k')).toEqual([]);
    const s2 = c.stamp('k');
    expect(s2).not.toBe(s);
    c.put('k', 0, bytes(0, 5), s2);
    expect(c.size()).toBe(5);
    const other = c.stamp('other');
    c.drop('k');
    expect(c.stamp('k')).not.toBe(s2);
    expect(c.stamp('other')).toBe(other); // a drop leaves other keys alone
    c.wipe();
    expect(c.stamp('other')).not.toBe(other);
  });

  it('drop and wipe free memory', () => {
    const c = new RangeCache();
    c.setMeta('a', 100, 'video/mp4');
    c.setMeta('b', 100, 'video/mp4');
    c.put('a', 0, bytes(0, 50));
    c.put('b', 0, bytes(0, 50));
    c.drop('a');
    expect(c.size()).toBe(50);
    expect(c.meta('a')).toBeUndefined();
    c.wipe();
    expect(c.size()).toBe(0);
    expect(c.ranges('b')).toEqual([]);
  });

  it('wipe announces every key it held, so open pages clear their cached stretches', () => {
    const c = new RangeCache();
    c.setMeta('a', 100, 'video/mp4');
    c.setMeta('b', 100, 'video/mp4');
    c.put('a', 0, bytes(0, 10));
    c.put('b', 0, bytes(0, 10));
    const before = c.snapshot('a').seq;
    const seen: string[] = [];
    c.onChange = (k) => seen.push(k);
    c.wipe();
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(c.snapshot('a')).toMatchObject({ total: 0, ranges: [] });
    expect(c.snapshot('a').seq).toBeGreaterThan(before);
    seen.length = 0;
    c.wipe(); // nothing held: nothing to announce
    expect(seen).toEqual([]);
  });

  it('lowerCap evicts down to a smaller cap at once and never raises it', () => {
    const MiB = 1024 * 1024;
    const c = new RangeCache(256 * MiB);
    c.setMeta('k', 200 * MiB, 'video/mp4');
    for (let i = 0; i < 100; i++) c.put('k', i * MiB, new Uint8Array(MiB));
    expect(c.size()).toBe(100 * MiB);
    const seen: string[] = [];
    c.onChange = (k) => seen.push(k);
    c.lowerCap(64 * MiB);
    expect(c.size()).toBeLessThanOrEqual(64 * MiB);
    expect(c.maxBytes).toBe(64 * MiB);
    expect(seen.length).toBeGreaterThan(0);
    c.lowerCap(256 * MiB); // another page asking for more does not raise it
    expect(c.maxBytes).toBe(64 * MiB);
    c.lowerCap(0); // nonsense is clamped, not obeyed
    expect(c.maxBytes).toBe(16 * MiB);
    c.lowerCap(Number.NaN);
    expect(c.maxBytes).toBe(16 * MiB);
  });
});
