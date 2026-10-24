import { describe, expect, it, vi } from 'vitest';
import { createFrameCache, type CachedFrame } from './frameCache';

function frame(mediaTime: number, close = vi.fn()): CachedFrame {
  return { image: { close } as unknown as CanvasImageSource, width: 160, height: 90, mediaTime };
}

describe('createFrameCache', () => {
  it('returns an exact hit by key', () => {
    const c = createFrameCache();
    const f = frame(5);
    c.put(5, f);
    expect(c.get(5)).toBe(f);
    expect(c.get(5.04)).toBeUndefined();
  });

  it('finds the nearest frame within the window, and nothing outside it', () => {
    const c = createFrameCache();
    c.put(2, frame(2));
    c.put(4, frame(4));
    expect(c.nearest(3.8, 1)?.mediaTime).toBe(4);
    expect(c.nearest(2.3, 1)?.mediaTime).toBe(2);
    expect(c.nearest(6, 1)).toBeUndefined();
  });

  it('caps at 60 frames, evicting the least recently used and closing it', () => {
    const c = createFrameCache();
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < 60; i++) { const cl = vi.fn(); closes.push(cl); c.put(i, frame(i, cl)); }
    c.get(0); // touch: 1 is now the oldest
    c.put(100, frame(100));
    expect(c.size()).toBe(60);
    expect(c.get(0)).toBeDefined();
    expect(c.get(1)).toBeUndefined();
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });

  it('clear() drops and closes every frame', () => {
    const c = createFrameCache();
    const cl = vi.fn();
    c.put(1, frame(1, cl));
    c.clear();
    expect(c.size()).toBe(0);
    expect(cl).toHaveBeenCalledTimes(1);
  });
});
