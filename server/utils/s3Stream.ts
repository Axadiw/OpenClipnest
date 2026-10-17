/**
 * S3 GetObject Body → HTTP response streaming with strict source cleanup.
 *
 * Why this module exists: the AWS SDK's `@smithy/node-http-handler` keeps a
 * per-host keep-alive agent (see services/s3.ts). HTTP/1.1 requires that a
 * connection's response body be fully read before the socket may be returned
 * to the pool — otherwise the agent has no way to tell where this response
 * ends and the next one begins, so it keeps the socket marked as in-use until
 * `socketTimeout` (10 s) fires. Raw `body.pipe(res)` does NOT destroy the
 * source when the destination errors or the client aborts, so every aborted
 * stream (Chrome seek, mobile drop, user nav-away) pins one socket for 10 s.
 * A sustained leak rate exhausts the pool and every subsequent `s3.send()`
 * starts queueing on socket acquisition and timing out — the wedge symptom
 * detected by utils/socketPoolWedge.ts.
 *
 * `stream.pipeline` propagates destroy() through the entire chain on any
 * failure, so the S3 body is torn down, the underlying socket is closed
 * (not pooled), and the agent immediately frees the slot. That's the cure
 * the wedge detector exists to mitigate.
 *
 * --- Slow-consumer kill (replaces the concurrency cap) ---
 *
 * `stream.pipeline` handles the ABORT case correctly, but it does NOT handle
 * the SLOW case. A client reading at 5 KB/s (phone on bad 4G, stalled TCP,
 * tab in background) backpressures the pipeline: the response socket's TCP
 * buffer fills, the throttle/res pauses the upstream body, the S3 socket
 * sits "in use" with no data flowing. From the keep-alive agent's view that
 * socket is unavailable. With enough slow clients the pool saturates and
 * fresh `s3.send()` calls start timing out at the agent — that's the wedge
 * the wedge-stress reproducer triggers.
 *
 * Fix: sample `res.socket.bytesWritten` on a 5 s tick. After a 10 s grace
 * period (cold-start + first GOP variance), if the per-tick rate falls below
 * SLOW_CONSUMER_THRESHOLD_KBPS for SLOW_CONSUMER_CONSECUTIVE_CHECKS ticks in
 * a row, destroy the upstream Body. That releases the S3 socket back to the
 * pool ~25 s after stall onset (10 s grace + 3 × 5 s checks) instead of
 * holding it for the full stream duration (often several minutes).
 *
 * Threshold tuning: 20 KB/s = ~160 Kbps. Camera streams are typically
 * 1-2 Mbps, so a client reading at 20 KB/s is buffering more than playing
 * and can't actually watch. Quota-throttled users (see decideThrottle in
 * events.ts) are paced at hundreds of KB/s — well above the threshold so
 * no false positives from legitimate paid-throttle behaviour. Override at
 * deploy time via SLOW_CONSUMER_THRESHOLD_KBPS=N if some new failure mode
 * needs different tuning.
 */
import { pipeline } from 'stream/promises';
import type { Readable, Writable, Duplex } from 'stream';
import type { EventEmitter } from 'events';
import { recordSlowConsumerKill, type VideoPath } from './metrics.js';

/**
 * Lifecycle events `stream/promises` pipeline + the `eos`/`finished` helpers
 * it calls internally attach to the *destination* stream. On Node 20 those
 * listeners are NOT removed when the pipeline settles — `pipeline` cleans up
 * the source chain but leaves ~4 `close` / 3 `error` / 2 `finish` / 2 `end`
 * handlers dangling on the destination (verified empirically against node
 * v20.20.2).
 *
 * For a per-request Express `ServerResponse` that gets piped exactly once,
 * those ~4 dangling `close` listeners stack on top of Express's own framework
 * listeners (its onfinish/onclose/abort handling) and push the response over
 * the default `MaxListeners = 10` ceiling — that is the source of the
 * `MaxListenersExceededWarning: 11 close listeners added to [ServerResponse]`
 * the thumbnail transaction trips.
 *
 * We do NOT raise the ceiling (that masks the leak). Instead we snapshot the
 * destination's lifecycle listeners *before* the pipeline and, once it has
 * settled, remove exactly the ones the pipeline added — leaving every
 * pre-existing Express/middleware listener untouched. The diff runs only in
 * the `finally`, after `pipeline` has done all of its own work (including the
 * client-abort → destroy-source teardown that happens *before* the promise
 * settles), so stripping these now-dormant listeners cannot change streaming
 * or abort semantics.
 */
// `unpipe` is included alongside the pipeline lifecycle events because the
// raw `source.pipe(dest)` path (pipeThrottleToResponse below) also leaves an
// `unpipe` listener on the destination — Node's Readable.prototype.pipe adds
// one `close`, one `finish`, one `error` AND one `unpipe` listener to `dest`
// per pipe (verified on node v20/v22). The `pipeline()` path does not add an
// `unpipe`, so snapshot+diff is a safe superset for both callers.
const PIPELINE_DEST_LIFECYCLE_EVENTS = ['close', 'error', 'finish', 'end', 'unpipe'] as const;

function snapshotDestListeners(dest: Writable): Map<string, Set<unknown>> {
  const emitter = dest as unknown as EventEmitter;
  const snap = new Map<string, Set<unknown>>();
  for (const ev of PIPELINE_DEST_LIFECYCLE_EVENTS) {
    snap.set(ev, new Set(emitter.listeners(ev)));
  }
  return snap;
}

function removePipelineDestListeners(dest: Writable, before: Map<string, Set<unknown>>): void {
  const emitter = dest as unknown as EventEmitter;
  for (const ev of PIPELINE_DEST_LIFECYCLE_EVENTS) {
    const pre = before.get(ev);
    if (!pre) continue;
    for (const fn of emitter.listeners(ev)) {
      if (!pre.has(fn)) {
        emitter.removeListener(ev, fn as (...args: unknown[]) => void);
      }
    }
  }
}

/**
 * `throttle.pipe(res)` for the multi-zone stitch paths in routes/events/video.ts
 * (streamPatchedMp4 / streamCleanFrameMp4 / the patched-moov pass-through),
 * with the same listener-leak guard `pipeS3ToResponse` applies to its
 * `pipeline()` calls.
 *
 * Why this matters: Node's `Readable.prototype.pipe` registers a `close`,
 * `finish`, `error` and `unpipe` listener on the *destination*. On a per-request
 * `ServerResponse` those stack on top of Express's framework listeners + this
 * route's own `res.once('finish'|'close')` transfer-accounting handlers. A
 * single pipe is harmless, but any path that pipes more than once onto the same
 * `res` (historically the clean-frame → fmp4 fall-through) — or simply enough
 * framework + app listeners — trips `MaxListenersExceededWarning: 11 close
 * listeners added to [ServerResponse]`.
 *
 * We snapshot the destination's lifecycle listeners before the pipe and, once
 * the throttle settles (end/close/error), remove exactly the ones `.pipe()`
 * added — leaving every pre-existing Express / app listener untouched. The
 * cleanup is idempotent (latched) and registered with `.once`, so it adds no
 * net listener of its own that could itself accumulate. Streaming semantics are
 * unchanged: the diff only removes now-dormant listeners after the stream is
 * done.
 *
 * CALLER CONTRACT: register the route's own `res.once('finish'|'close', …)`
 * handlers (e.g. transfer accounting) BEFORE calling this — they must be in the
 * pre-pipe snapshot so the cleanup diff preserves them. video.ts does this at
 * the top of the handler. Anything registered on `res` AFTER this call would be
 * (correctly) seen as pipe-added and stripped.
 */
export function pipeThrottleToResponse(throttle: Duplex, res: Writable): void {
  const before = snapshotDestListeners(res);
  throttle.pipe(res);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    removePipelineDestListeners(res, before);
  };
  // Strip the pipe-added listeners on whichever terminal event fires first.
  // `end` = the throttle's readable side fully drained, i.e. `.pipe` has pushed
  // every byte into `res` and (with default `{end:true}`) called `res.end()`;
  // `close`/`error` cover abort/teardown. We listen on the throttle (the
  // SOURCE, one per request) — never on `res` — so this guard itself can never
  // add to a res listener pile-up. Verified: stripping here delivers the full
  // body even under backpressure (no truncation).
  throttle.once('end', cleanup);
  throttle.once('close', cleanup);
  throttle.once('error', cleanup);
}

// Tuning (post-OOM): tightened from the initial 10s+5s×3=25s
// total-kill-time to 3s+2s×2=7s. Reasoning: a stream backpressuring at the
// Node pipeline layer accumulates Readable internal buffer at the rate the
// upstream S3 body produces (often MB/s) while the kill timer counts down.
// At the original 25s, ~50 concurrent slow streams accumulated enough buffer
// to OOM the 2 Gi pod under the wedge-stress reproducer. 7s caps the per-
// stream buffer-growth window at a fraction of that. Cold-start path tested
// to first-byte in ~500 ms-3 s on prod (token validate + headObject +
// getObject TTFB), so a 3 s grace leaves margin without false-positivnie
// killing healthy streams in their warmup window. All four knobs remain
// env-overridable for emergency re-tuning without a deploy.
export const SLOW_CONSUMER_GRACE_MS = parseInt(
  process.env.SLOW_CONSUMER_GRACE_MS || '3000',
  10,
);
export const SLOW_CONSUMER_CHECK_INTERVAL_MS = parseInt(
  process.env.SLOW_CONSUMER_CHECK_INTERVAL_MS || '2000',
  10,
);
export const SLOW_CONSUMER_THRESHOLD_KBPS = parseFloat(
  process.env.SLOW_CONSUMER_THRESHOLD_KBPS || '20',
);
export const SLOW_CONSUMER_CONSECUTIVE_CHECKS = parseInt(
  process.env.SLOW_CONSUMER_CONSECUTIVE_CHECKS || '2',
  10,
);

/** Sentinel error message — route handlers can match on this to log/metric. */
export const SLOW_CONSUMER_ERROR_MESSAGE = 'slow consumer: client read rate below threshold, upstream S3 socket released';

/**
 * Spin up a slow-consumer monitor for a given response. Reads
 * `res.socket.bytesWritten` periodically; if the rate is too low for too
 * long, calls `onSlowConsumer` so the caller can `body.destroy(err)`.
 *
 * Returns a cleanup function — call it once the pipeline settles (success,
 * abort, or natural end) to stop the interval.
 *
 * Exported for testing; production callers use it via `pipeS3ToResponse`.
 */
/**
 * Sampling flag for the diagnostic logging added when the
 * slow-kill failed to fire under load. Setting `SLOW_KILL_DEBUG=1` makes
 * the monitor emit one structured log line per attach (with everything
 * we know about `res.socket`) and per first three ticks (with the
 * bytesWritten deltas it's reading). Once we understand the production
 * Express socket contract this whole block can be deleted. Default off
 * so a production left at this version doesn't spam logs.
 */
const SLOW_KILL_DEBUG = process.env.SLOW_KILL_DEBUG === '1';
let SLOW_KILL_DEBUG_COUNTER = 0;

export function attachSlowConsumerMonitor(
  res: Writable,
  onSlowConsumer: (rateKbps: number) => void,
): () => void {
  // `Writable` doesn't expose `.socket` in the type system, but Express
  // responses are HTTP responses and always have one. Defensive read in
  // case a test passes a raw Writable (no socket → no monitoring).
  // `connection` is an older alias for `socket`; some Express versions
  // populate one but not the other in unusual transport layers, so try
  // both before bailing out.
  const wholeRes = res as { socket?: { bytesWritten?: number }; connection?: { bytesWritten?: number } };
  const sock = wholeRes.socket ?? wholeRes.connection;
  const dbgId = SLOW_KILL_DEBUG ? ++SLOW_KILL_DEBUG_COUNTER : 0;

  if (SLOW_KILL_DEBUG) {
    const sockKeys = sock ? Object.keys(sock).filter((k) => !k.startsWith('_')).slice(0, 20) : [];
    console.log(
      `[slowkill-debug ${dbgId}] attach: socketTypeof=${typeof wholeRes.socket}, connectionTypeof=${typeof wholeRes.connection}, ` +
      `socketEqConnection=${wholeRes.socket === wholeRes.connection}, bytesWritten=${sock?.bytesWritten} (typeof ${typeof sock?.bytesWritten}), ` +
      `keys=[${sockKeys.join(',')}]`,
    );
  }

  if (!sock || typeof sock.bytesWritten !== 'number') {
    if (SLOW_KILL_DEBUG) console.log(`[slowkill-debug ${dbgId}] bailed: no usable socket/bytesWritten`);
    return () => undefined;
  }

  const startMs = Date.now();
  const startBytes = sock.bytesWritten;
  let lastTickBytes = startBytes;
  let slowConsecutive = 0;
  let stopped = false;
  let tickCount = 0;

  const interval = setInterval(() => {
    if (stopped) return;
    const elapsedMs = Date.now() - startMs;
    if (elapsedMs < SLOW_CONSUMER_GRACE_MS) {
      if (SLOW_KILL_DEBUG && tickCount < 3) {
        console.log(`[slowkill-debug ${dbgId}] tick (grace): elapsed=${elapsedMs}ms, bytesWritten=${sock.bytesWritten}`);
      }
      tickCount += 1;
      return;
    }

    const written = sock.bytesWritten ?? lastTickBytes;
    const intervalBytes = written - lastTickBytes;
    lastTickBytes = written;
    const rateKbps = intervalBytes / 1024 / (SLOW_CONSUMER_CHECK_INTERVAL_MS / 1000);

    if (SLOW_KILL_DEBUG && tickCount < 5) {
      console.log(
        `[slowkill-debug ${dbgId}] tick: elapsed=${elapsedMs}ms, bytesWritten=${written}, ` +
        `delta=${intervalBytes}, rate=${rateKbps.toFixed(1)}KB/s, ` +
        `slowConsec=${slowConsecutive}/${SLOW_CONSUMER_CONSECUTIVE_CHECKS}`,
      );
    }
    tickCount += 1;

    if (rateKbps < SLOW_CONSUMER_THRESHOLD_KBPS) {
      slowConsecutive += 1;
      if (slowConsecutive >= SLOW_CONSUMER_CONSECUTIVE_CHECKS) {
        stopped = true;
        clearInterval(interval);
        onSlowConsumer(rateKbps);
      }
    } else {
      slowConsecutive = 0;
    }
  }, SLOW_CONSUMER_CHECK_INTERVAL_MS);
  // `unref()` so a wedged monitor never keeps the event loop alive past
  // process shutdown — defensive only; cleanup() should always fire first.
  if (typeof interval.unref === 'function') interval.unref();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/**
 * Pipe an S3 GetObject Body into the HTTP response, optionally through a
 * single throttle transform. Resolves when the response is fully written;
 * rejects (and destroys the source) on any failure — including the client
 * disconnecting mid-stream or triggering the slow-consumer kill.
 *
 * Slow-kill default flipped to ON in v0.10.272 along with the diagnostic
 * logging in attachSlowConsumerMonitor (set `SLOW_KILL_DEBUG=1` to enable).
 * The earlier "ZERO firings under load" observation came from the kill
 * being feature-flagged off via `ENABLE_SLOW_CONSUMER_KILL` defaulting to
 * `'false'` — the monitor was attached but the route never set the env
 * var, so the helper returned a no-op. Default flipped to `'true'`; set
 * `ENABLE_SLOW_CONSUMER_KILL=false` to disable.
 */
const SLOW_CONSUMER_KILL_ENABLED = (process.env.ENABLE_SLOW_CONSUMER_KILL ?? 'true') === 'true';

export async function pipeS3ToResponse(
  body: Readable,
  res: Writable,
  throttle?: Duplex,
  metricsPath: VideoPath = 'patched',
): Promise<void> {
  let stopMonitor: () => void = () => undefined;
  if (SLOW_CONSUMER_KILL_ENABLED) {
    stopMonitor = attachSlowConsumerMonitor(res, (rateKbps) => {
      // info-level: the kill is expected, intentional behaviour. Sentry
      // captureConsoleIntegration captures warn+error for the api service,
      // so a warn here surfaces every slow-client drop as a noise issue.
      // Match the streamPatchedMp4 path (routes/events.ts) for consistency.
      console.log(
        `[s3Stream] slow consumer killed: ${rateKbps.toFixed(1)} KB/s sustained (threshold ${SLOW_CONSUMER_THRESHOLD_KBPS} KB/s)`,
      );
      recordSlowConsumerKill(metricsPath);
      if (!body.destroyed) body.destroy(new Error(SLOW_CONSUMER_ERROR_MESSAGE));
    });
  }

  // Snapshot res's lifecycle listeners so we can strip exactly the ones the
  // pipeline leaves behind (see PIPELINE_DEST_LIFECYCLE_EVENTS doc above).
  const destListenersBefore = snapshotDestListeners(res);
  try {
    if (throttle) {
      await pipeline(body, throttle, res);
    } else {
      await pipeline(body, res);
    }
  } finally {
    stopMonitor();
    // Remove the dangling close/error/finish listeners pipeline added to res.
    // Without this they accumulate (one set per pipe) and trip
    // MaxListenersExceededWarning on the ServerResponse.
    removePipelineDestListeners(res, destListenersBefore);
  }
}

/**
 * Pipe an S3 GetObject Body into a sink without ending the sink on body EOF.
 * Used when multiple sequential bodies feed one shared sink (e.g. the
 * three-zone fmp4 stitcher in streamPatchedMp4).
 *
 * Resolves on natural body EOF — sink stays writable for the next source.
 * On sink failure, destroys the body (releases the keep-alive socket) and
 * rejects with the sink error. On body failure, rejects with the body
 * error; the caller is responsible for tearing down the sink in its outer
 * try/catch (the sink belongs to the caller, not to this helper).
 */
export function pipeS3IntoSink(body: Readable, sink: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      sink.off('error', onSinkError);
      body.off('error', onBodyError);
      body.off('end', onBodyEnd);
      if (err) {
        // We may have just asked the body to `destroy(err)`. The Readable
        // will re-emit that error asynchronously; swallow it (the caller
        // has already received the same error via `reject`) so it does not
        // bubble up as an unhandled 'error' event on the process.
        body.on('error', () => {});
        reject(err);
      } else {
        resolve();
      }
    };
    const onSinkError = (err: Error) => {
      // Sink died (client disconnected) — destroy the source so its
      // underlying TCP socket is released back to the agent pool. Without
      // this, the body keeps reading into a dead sink and the socket is
      // pinned as in-use until socketTimeout (10 s).
      if (!body.destroyed) body.destroy(err);
      finish(err);
    };
    const onBodyError = (err: Error) => finish(err);
    const onBodyEnd = () => finish(null);
    sink.on('error', onSinkError);
    body.on('error', onBodyError);
    body.on('end', onBodyEnd);
    body.pipe(sink, { end: false });
  });
}
