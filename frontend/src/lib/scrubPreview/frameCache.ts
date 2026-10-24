/**
 * In-memory LRU of preview frames already painted for one recording, so hovering a spot again
 * (or near it) draws at once. Memory only: the owner clears it on recording change, unmount and
 * sign-out. Keys are seconds: the exact frame time when a sample index exists, otherwise the
 * pointed-at time rounded to 0.1 s.
 */
export interface CachedFrame {
  /** `ImageBitmap` where available, otherwise a small canvas copy. */
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Presentation time of the frame: the confirmed mediaTime, or NaN when it was never confirmed (such a frame only stands in as a near hit). */
  mediaTime: number;
}

export const FRAME_CACHE_MAX = 60;

export interface FrameCache {
  get(key: number): CachedFrame | undefined;
  /** The cached frame whose key is closest to `t`, if within `maxDist` seconds. */
  nearest(t: number, maxDist: number): CachedFrame | undefined;
  put(key: number, frame: CachedFrame): void;
  clear(): void;
  size(): number;
}

function release(f: CachedFrame): void {
  (f.image as { close?: () => void }).close?.();
}

export function createFrameCache(max = FRAME_CACHE_MAX): FrameCache {
  // A Map iterates in insertion order: re-inserting on use keeps the oldest first.
  const frames = new Map<number, CachedFrame>();
  return {
    get(key) {
      const f = frames.get(key);
      if (f) { frames.delete(key); frames.set(key, f); }
      return f;
    },
    nearest(t, maxDist) {
      let best: CachedFrame | undefined;
      let bestDist = Infinity;
      for (const [k, f] of frames) {
        const d = Math.abs(k - t);
        if (d <= maxDist && d < bestDist) { best = f; bestDist = d; }
      }
      return best;
    },
    put(key, frame) {
      const old = frames.get(key);
      if (old && old !== frame) release(old);
      frames.delete(key);
      frames.set(key, frame);
      while (frames.size > max) {
        const [k, f] = frames.entries().next().value as [number, CachedFrame];
        frames.delete(k);
        release(f);
      }
    },
    clear() {
      for (const f of frames.values()) release(f);
      frames.clear();
    },
    size: () => frames.size,
  };
}

/**
 * Copies what `canvas` shows now into a cacheable frame. `createImageBitmap` snapshots the
 * canvas at call time; without it a same-size canvas copy is made synchronously.
 */
export async function snapshotCanvas(canvas: HTMLCanvasElement, mediaTime: number): Promise<CachedFrame | null> {
  const { width, height } = canvas;
  if (!width || !height) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      return { image: await createImageBitmap(canvas), width, height, mediaTime };
    } catch { /* fall back to a copy */ }
  }
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  return { image: copy, width, height, mediaTime };
}
