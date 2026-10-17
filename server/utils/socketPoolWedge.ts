/**
 * Shared S3-socket-pool wedge detector.
 *
 * The AWS SDK's NodeHttpHandler keeps a per-host keep-alive agent. Under
 * certain failure modes (long-lived idle sockets that get silently dropped
 * by an intermediate NAT/LB; SDK bug; OS-level FD exhaustion; per-host
 * `maxSockets` saturated by slow consumers) every fresh `s3.send()` ends up
 * queueing against a wedged socket pool and times out after
 * `connectionTimeout` (15 s here). The pool never recovers on its own
 * because every dispatch picks the same broken sockets.
 *
 * Recovery is a process restart — the new pod gets a fresh `https.Agent`.
 * Both thumbnail-worker and the API need this; this module is the single
 * source of truth so future services (event-manager, scanner) can opt in
 * with one import.
 *
 * Usage:
 *   1. After every S3-touching operation, call `recordConnectOutcome(err)`
 *      with the caught error (or `undefined` on success).
 *   2. Hand `socketPoolHealthCheck` to `startHealthzServer` (workers) or
 *      call it inside an Express `/healthz` handler (API).
 *   3. The kubelet liveness probe flips the pod to NotReady once the
 *      detector returns `{ok: false}` and the pod gets recreated.
 *
 * --- Redesign — streak → window ---
 *
 * The original detector used a simple "10 consecutive connect-timeouts"
 * streak counter. That had a subtle failure mode a real wedge exposed
 * under load: with the pool saturated, individual S3 sub-calls
 * pulsed between success and timeout (some sockets cycled, others stayed
 * stuck). A single intermediate success reset the streak counter to 0, so
 * /healthz never returned a stable 503, so the kubelet liveness probe
 * never accumulated its 3 consecutive failures, so the pod sat in `0/1`
 * NotReady for tens of minutes — serving 5xx to real users without
 * being restarted.
 *
 * Replacement: rolling time-window. We count timeout outcomes within the
 * last `WINDOW_MS` (30 s). When at least `MIN_FAILURES_TO_TRIP` (5) and
 * MORE than half of recent outcomes were timeouts, we declare the pool
 * wedged. Intermediate successes no longer reset the verdict — they shift
 * the ratio. Once the wedge clears (or the window ages out) /healthz
 * returns 200 again immediately, which is what we want for the post-
 * restart fresh-pod recovery path. See socketPoolWedge.test.ts for the
 * full contract.
 *
 * Trade-offs we accepted:
 *   - On a pod with VERY low S3 traffic (e.g. nightly cron only), 5 quick
 *     real failures in 30 s would trip the detector. That is correct —
 *     5 connect-timeouts on a pod doing one call/minute IS a wedge. The
 *     old "10-streak" would also have tripped here, just later.
 *   - The detector trips faster under sustained pressure (now ~5 timeouts
 *     instead of needing 10 in a row uninterrupted). Acceptable: a real
 *     wedge under load throws hundreds of timeouts per second; tripping
 *     5 % earlier saves real-user 5xx exposure.
 */

// Substring match against `err.message`. Anchored on the prefix produced by
// `@smithy/node-http-handler` when its connect or socket-acquisition timeout
// fires. The full message starts with that prefix (varies by SDK version) so
// using a substring keeps us forward-compatible across minor SDK upgrades.
export const CONNECT_TIMEOUT_MARKER =
  'did not establish a connection with the server within the configured timeout';

/**
 * Rolling window length. Long enough that a healthy pod with ~1 call/sec
 * has dozens of samples to denominate the failure ratio; short enough that
 * a freshly-restarted pod doesn't carry pre-restart history (pods don't
 * — the array is per-process — but the timeline matters for in-place
 * recovery during a transient the object store blip).
 */
export const WINDOW_MS = 30_000;

/**
 * Minimum number of timeouts inside the window before we'll even consider
 * the pool wedged. Below this, transient noise (one bad load-balancer hop,
 * one DNS hiccup) can't trip the detector regardless of total volume.
 */
export const MIN_FAILURES_TO_TRIP = 5;

/**
 * Ratio of timeouts / total-recent-outcomes required to declare wedge.
 * Strict `>` (not `>=`) so a pod that's bouncing 50/50 between success and
 * fail gets the benefit of the doubt for one more sample. A real wedge
 * pushes well past 50 % within a couple of seconds.
 */
export const WEDGE_FAILURE_RATIO = 0.5;

interface Outcome {
  ts: number;
  failed: boolean;
}

const recent: Outcome[] = [];

function pruneOlderThan(cutoff: number): void {
  // Outcomes are appended in chronological order, so we can stop at the
  // first one that's still inside the window. O(N) per prune, but N is
  // bounded by traffic-rate × window, so for a busy pod doing 1k S3 calls/s
  // and a 30s window that's at most ~30k entries (each ~16B) — sub-1MB.
  let drop = 0;
  while (drop < recent.length && recent[drop].ts < cutoff) drop += 1;
  if (drop > 0) recent.splice(0, drop);
}

/**
 * Record the outcome of an S3-touching call. Pass the caught error on
 * failure, or `undefined` (or no arg) on success. The detector classifies
 * connect-timeout failures specifically — generic S3 errors (NoSuchKey,
 * AccessDenied, transient 5xx from the object store) count as non-timeout
 * outcomes and shift the ratio AWAY from wedge, same as a clean success.
 * Only the connect-timeout marker counts toward the wedge ratio.
 */
export function recordConnectOutcome(err?: unknown): void {
  const now = Date.now();
  pruneOlderThan(now - WINDOW_MS);
  let failed = false;
  if (err !== undefined) {
    const msg = err instanceof Error ? err.message : String(err);
    failed = msg.includes(CONNECT_TIMEOUT_MARKER);
  }
  recent.push({ ts: now, failed });
}

/**
 * Health-check hook. Returns `{ok: false, ...}` when the rolling window
 * shows at least `MIN_FAILURES_TO_TRIP` connect-timeouts AND more than
 * `WEDGE_FAILURE_RATIO` of recent outcomes were timeouts. Wire this into
 * `/healthz` so the kubelet liveness probe trips and recreates the pod.
 */
export function socketPoolHealthCheck(): { ok: boolean; reason?: string } {
  const now = Date.now();
  pruneOlderThan(now - WINDOW_MS);
  const total = recent.length;
  if (total === 0) return { ok: true };
  let failed = 0;
  for (const o of recent) if (o.failed) failed += 1;
  if (failed >= MIN_FAILURES_TO_TRIP && failed / total > WEDGE_FAILURE_RATIO) {
    return {
      ok: false,
      reason: `${failed}/${total} S3 connect-timeouts in last ${WINDOW_MS}ms — socket pool wedged, restart required`,
    };
  }
  return { ok: true };
}

// --- test-only helpers ---

export function _getRecentCountForTesting(): { total: number; failed: number } {
  const now = Date.now();
  pruneOlderThan(now - WINDOW_MS);
  let failed = 0;
  for (const o of recent) if (o.failed) failed += 1;
  return { total: recent.length, failed };
}

export function _resetForTesting(): void {
  recent.length = 0;
}
