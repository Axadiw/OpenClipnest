/**
 * Per-pod concurrency cap for S3-heavy endpoints (video streams).
 *
 * Wedge-protection saga, condensed:
 *
 *   v0.10.211 (baseline) — no cap, naïve pool. 100-VU stress wedged in ~70s.
 *   v0.10.268 — global cap=50, eliminated wedge. Operator vetoed: too low,
 *               blocks legitimate users at >50 concurrent /video streams
 *               across the pod (real concern at 100+ users).
 *   v0.10.269 — drop cap, slow-consumer kill in s3Stream.ts, maxSockets=2000.
 *               OOM-killed at ~4 min into the stress (native socket overhead
 *               + Node pipeline buffers scaled past the 2 Gi pod limit).
 *   v0.10.270 — keep slow-kill but tighten 7s kill latency and revert
 *               maxSockets=500. Wedged anyway: slow-kill fired ZERO times
 *               in production despite hundreds of slow streams hitting it
 *               (likely res.socket / bytesWritten semantics differ from
 *               our test mock — separate investigation owed).
 *   v0.10.271 (first cut) — added a per-user cap of 5 on top of the global
 *               cap. Per-user=5 immediately broke the e2e timeline tests
 *               because a single video playback opens 5+ concurrent
 *               range requests (browser prefetch + multi-segment scrub),
 *               so the 6th got 429 and video seek failed. Removed the
 *               per-user tier.
 *   v0.10.271 (this file) — single tier: global per-pod cap, default 200.
 *               4× the v0.10.268 value so legitimate 100+ user scenarios
 *               fit (100 users × ~1-2 simultaneous streams = 100-200,
 *               at cap). Doesn't carve out per-user fairness, but the
 *               external `mediaRateLimit` (3000 req/min per IP) handles
 *               sustained-abuse scenarios; this cap only protects the
 *               instantaneous socket pool.
 *
 * Tunable via env: `VIDEO_CONCURRENCY_LIMIT` (e.g. raise to 400 if pod
 * scales up; lower for a tiny-instance deploy).
 *
 * In-memory (NOT Redis) — per-pod backpressure. Horizontal scaling
 * (more replicas) multiplies effective capacity.
 */
import type { Request, Response, NextFunction } from 'express';
import { recordVideoServeFailure } from '../utils/metrics.js';

const VIDEO_CONCURRENCY_LIMIT = parseInt(
  process.env.VIDEO_CONCURRENCY_LIMIT || '200',
  10,
);

let inFlight = 0;

/**
 * Express middleware. Mount BEFORE the route handler — `release` is wired
 * to `res.on('close')`, which fires for both normal completion and client
 * disconnect, so the counter always drains.
 *
 * Returns 429 with `Retry-After: 3` when at capacity. The route handler is
 * never reached in that case, so no S3 call is made and no socket is
 * acquired — that's the entire point.
 */
export function videoConcurrencyCap(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (inFlight >= VIDEO_CONCURRENCY_LIMIT) {
    // A 429 mid-stream is invisible to a native player — it just stops
    // downloading — so this counter is the only way to tell "the pod was at
    // capacity" apart from the other causes of a frozen video.
    recordVideoServeFailure('concurrency_cap');
    res.setHeader('Retry-After', '3');
    res.status(429).json({
      error: 'Server is processing too many video streams; retry shortly',
      code: 'VIDEO_CONCURRENCY_LIMIT_REACHED',
    });
    return;
  }

  inFlight += 1;
  let released = false;
  res.once('close', () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
  });

  next();
}

/** Diagnostics — current in-flight count for this pod. */
export function getInFlightVideoCount(): number {
  return inFlight;
}

/** Test-only — reset the counter between unit tests. */
export function _resetForTesting(): void {
  inFlight = 0;
}

/** Test-only — expose the limit so tests don't hardcode the number. */
export function _getLimitForTesting(): number {
  return VIDEO_CONCURRENCY_LIMIT;
}
