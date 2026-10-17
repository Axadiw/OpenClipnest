import { Transform } from 'node:stream';

/**
 * Throttle decision based on the user's current monthly transfer usage
 * vs their plan limit. Three bands:
 *
 *   - <90% of limit          → pass-through, no throttle
 *   - 90% to <120% of limit  → soft-throttle to 512 KB/s
 *   - >=120% of limit        → hard-block (caller should respond 429)
 *
 * `limitBytes <= 0` means the user has no limit (unlimited plan or
 * defensive case) — always pass.
 */
export type ThrottleDecision =
  | { mode: 'pass' }
  | { mode: 'throttle'; bytesPerSec: number }
  | { mode: 'block' };

const SOFT_THROTTLE_BYTES_PER_SEC = 512 * 1024;
const SOFT_THROTTLE_RATIO = 0.9;
const HARD_BLOCK_RATIO = 1.2;

export function decideThrottle(usedBytes: number, limitBytes: number): ThrottleDecision {
  if (limitBytes <= 0) return { mode: 'pass' };
  const ratio = usedBytes / limitBytes;
  if (ratio >= HARD_BLOCK_RATIO) return { mode: 'block' };
  if (ratio >= SOFT_THROTTLE_RATIO) {
    return { mode: 'throttle', bytesPerSec: SOFT_THROTTLE_BYTES_PER_SEC };
  }
  return { mode: 'pass' };
}

/**
 * Token-bucket Transform stream. Yields data at no more than bytesPerSec.
 * Pass null / 0 / negative for unlimited (pass-through).
 *
 * Implementation: tracks bytes emitted in a rolling 1-second window.
 * If the next chunk would exceed the budget, defer it via setTimeout
 * for the time needed to drain to budget.
 */
export function buildThrottleStream(bytesPerSec: number | null): Transform {
  if (bytesPerSec === null || bytesPerSec <= 0) {
    return new Transform({ transform(c, _e, cb) { cb(null, c); } });
  }
  let windowStart = Date.now();
  let bytesInWindow = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesInWindow += chunk.length;
      const expectedMs = (bytesInWindow / bytesPerSec) * 1000;
      const elapsed = Date.now() - windowStart;
      const sleep = Math.max(0, expectedMs - elapsed);
      const emit = () => {
        // Reset every second so the integer counters don't grow unbounded.
        if (Date.now() - windowStart > 1000) {
          windowStart = Date.now();
          bytesInWindow = chunk.length;
        }
        cb(null, chunk);
      };
      if (sleep === 0) emit();
      else setTimeout(emit, sleep);
    },
  });
}
