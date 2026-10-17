import { hostname } from 'node:os';
import { getRedis } from '../utils/redis.js';

// ---------------------------------------------------------------------------
// Redis Streams — inter-service message bus.
//
// Delivery guarantees:
//   - consumer groups with ack-on-process (XREADGROUP + XACK)
//   - per-pod recovery (XPENDING + XCLAIM) so a crashed pod doesn't lose work
//   - dead-letter queue for poison-pill messages (XADD on a DLQ stream after
//     N deliveries)
//
// Stream names and consumer groups
//
//   stream:scan-trigger      (retired R3 — scanner Deployment deleted 2026-06-15)
//   stream:delete-notify     event-managers     # delete → targeted update
//   stream:thumbnail         thumbnail-workers  # event → thumbnail job
//   stream:thumbnail-dlq     —                  # poison pills (inspected only)
// ---------------------------------------------------------------------------

export const STREAM_SCAN_TRIGGER = 'stream:scan-trigger';
export const STREAM_DELETE_NOTIFY = 'stream:delete-notify';
export const STREAM_THUMBNAIL_GENERATE = 'stream:thumbnail';
export const STREAM_DLQ_THUMBNAIL = 'stream:thumbnail-dlq';
// Push fan-out: createNotification() publishes here after the row insert; the
// push-worker group consumes, resolves the user's devices + prefs, and sends
// via APNs. Decoupled from the insert so a slow/absent APNs never blocks the
// notification write (fire-and-forget XADD).
export const STREAM_PUSH = 'stream:push';
export const STREAM_DLQ_PUSH = 'stream:push-dlq';

export const GROUP_EVENT_MANAGERS = 'event-managers';
export const GROUP_THUMBNAIL_WORKERS = 'thumbnail-workers';
export const GROUP_PUSH_WORKERS = 'push-workers';

/** Unique consumer name for this process — `<hostname>-<pid>`. */
export function defaultConsumerName(): string {
  return `${hostname()}-${process.pid}`;
}

/**
 * Marker class re-thrown by a handler that has already classified an error as
 * transient and logged it at info-level. `processOne`'s catch branch sees the
 * marker, logs at `console.log` instead of `console.error`, and Sentry's
 * `captureConsoleIntegration` filter (sentry.ts) leaves the event out of the
 * inbox. Without this, the handler's silenced inner log was still surfacing to
 * Sentry through the outer streamsClient catch — generating one issue per
 * transient retry. XCLAIM retry
 * mechanics stay identical: the thrown error still bypasses XACK so the entry
 * remains in PEL for reclaim or DLQ after `maxDeliveries`.
 */
export class HandledTransientError extends Error {
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = 'HandledTransientError';
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Publish a string-valued JSON-ish payload onto a stream. Values pass through
 * as Redis stream fields (key-value pairs), so payloads must be flat
 * `Record<string,string>` — complex types should be `JSON.stringify`'d by the
 * caller into a single field.
 *
 * `MAXLEN ~ 10000` caps the stream at ~10k most recent entries. Tilde means
 * Redis can trim to a slightly higher bound for performance. 10k covers the
 * worst case of a full day of uploads stalled awaiting consumer recovery.
 */
export async function publish(
  stream: string,
  payload: Record<string, string>,
  opts: { maxLen?: number } = {},
): Promise<string> {
  const redis = getRedis();
  // 2M absorbs a full wipe of a 10 TB user prefix (~1.2M keys) without
  // dropping messages. Must stay in lockstep with the Rust FTPS publisher
  // (`ftps-server/src/streams.rs::MAXLEN`).
  const maxLen = opts.maxLen ?? 2_000_000;
  const flat: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    flat.push(k, v);
  }
  return redis.xadd(stream, 'MAXLEN', '~', String(maxLen), '*', ...flat) as Promise<string>;
}

function thumbnailDedupKey(eventId: string): string {
  return `thumbnail-published:${eventId}`;
}

/**
 * Publish a thumbnail-generation job ONLY when no recent publish for this
 * `eventId` exists. Without this, the per-minute reconciler in
 * `scan-once.ts` would re-publish the same NULL-thumbnail
 * events every cron tick, building 100k+ stream lag (worker can't catch up
 * because most of what it reads is "already has thumbnail, skipping" no-ops
 * from earlier publishes of the same event). 600s TTL gives the worker a
 * 10-minute window to actually process; if it doesn't, the natural expiry
 * triggers a single retry on the next reconciler tick.
 */
export async function publishThumbnailUnique(
  eventId: string,
  ownerId: number,
  opts: { ttlSecs?: number; notify?: boolean } = {},
): Promise<'published' | 'deduped'> {
  const redis = getRedis();
  const ttl = opts.ttlSecs ?? 600;
  const acquired = await redis.set(thumbnailDedupKey(eventId), '1', 'EX', ttl, 'NX');
  if (acquired !== 'OK') return 'deduped';
  // `notify` gates the worker's new_recording push: true only on the scanner's
  // fresh-discovery (ingest) path; every reconciler/backfill caller leaves it
  // false (the default) so a backlog drain can't announce. Always send the
  // field explicitly so the worker's `f.notify === 'true'` decode is stable.
  await publish(STREAM_THUMBNAIL_GENERATE, {
    eventId,
    ownerId: String(ownerId),
    notify: opts.notify ? 'true' : 'false',
  });
  return 'published';
}

/**
 * Drop the dedup lock so the next reconciler tick can re-publish. Called by
 * the thumbnail worker when it detects a "racy publish": the event references
 * a video view whose file_metadata row hasn't been inserted yet (Reolink
 * frequently uploads the two views of a dual-view event seconds-to-minutes
 * apart; the scanner can pair them in `events` from the filename pattern
 * before the second view has finished uploading). Without this DEL the 600s
 * TTL on the SETNX above would silently swallow every retry — the file would
 * stay "Processing…" on the frontend until the lock expired naturally.
 */
export async function clearThumbnailDedup(eventId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(thumbnailDedupKey(eventId));
}

/**
 * @deprecated The scanner Deployment (`clipnest-event-manager`) was retired in
 * R3 (2026-06-15). `stream:scan-trigger` has no consumer in production — this
 * call is a retained no-op until callers in storageReconciler.ts and
 * wipe-user-content.ts are cleaned up. Remove callers and this function when
 * the transition is complete.
 */
export async function publishScanTrigger(userUuid: string, s3Key: string): Promise<void> {
  await publish(STREAM_SCAN_TRIGGER, { userUuid, s3Key }, { maxLen: 10_000 });
}

/**
 * Fan a created notification out to the push-worker group. All fields are
 * strings (Redis stream fields); `details` is JSON-encoded by the caller into
 * a single field. MAXLEN 100k bounds the stream — push is best-effort, so a
 * deep backlog (worker down) is trimmed rather than retained forever.
 */
export interface PushStreamFields {
  userId: string;
  notificationId: string;
  kind: string;
  title: string;
  message: string;
  /** JSON string of the notification's `details` object ('{}' when none). */
  details: string;
}

export async function publishPush(fields: PushStreamFields): Promise<void> {
  // Spread into a plain Record<string,string> — `publish` expects flat
  // string-valued fields and `PushStreamFields` has no index signature.
  await publish(STREAM_PUSH, { ...fields }, { maxLen: 100_000 });
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

export interface ConsumerOptions<T> {
  stream: string;
  group: string;
  consumerName?: string;
  /** Stream to XADD poison-pill messages to (after `maxDeliveries`). */
  dlq?: string;
  /** How many times a message may be delivered before going to DLQ. Default 3. */
  maxDeliveries?: number;
  /** Pending messages idle longer than this are reclaimed via XCLAIM. Default 30s. */
  reclaimStaleMs?: number;
  /** Batch size for XREADGROUP COUNT. Default 10. */
  count?: number;
  /** BLOCK duration in ms for XREADGROUP. Default 5000. */
  blockMs?: number;
  /**
   * Max handlers to run in parallel within a single batch. Default 1
   * (sequential). Set >1 to process a batch fan-out — each message still
   * XACKs independently, so a single failure only leaves its own entry in the
   * PEL for reclaim.
   */
  concurrency?: number;
  /** Parse the stream fields into an application payload. Default: fields as-is. */
  parse?: (fields: Record<string, string>) => T;
  handler: (
    payload: T,
    meta: { stream: string; messageId: string; deliveryCount: number },
  ) => Promise<void>;
}

export interface Consumer {
  stop(): Promise<void>;
}

/**
 * Start a consumer on `stream` as part of `group`. Returns a handle with
 * `stop()` that drains the loop cleanly (finishes current message, then
 * returns).
 *
 * Delivery semantics: at-least-once. Handler must be idempotent.
 */
export function consume<T = Record<string, string>>(opts: ConsumerOptions<T>): Consumer {
  const consumer = opts.consumerName ?? defaultConsumerName();
  const maxDeliveries = opts.maxDeliveries ?? 3;
  const reclaimStaleMs = opts.reclaimStaleMs ?? 30_000;
  const count = opts.count ?? 10;
  const blockMs = opts.blockMs ?? 5000;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const parse = opts.parse ?? ((f) => f as unknown as T);

  let stopped = false;
  let stopResolve: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  // Each consumer gets its own dedicated Redis connection. xreadgroup BLOCK
  // holds the connection for the BLOCK duration, so multiple consumers
  // sharing the singleton serialize their reads (consumer N waits up to
  // N*blockMs for its turn). On a 3-consumer setup with blockMs=5000 that
  // pushed scan-trigger latency past e2e-backend's 30 s test timeouts.
  // duplicate() forks the client config (host/port/auth) into a fresh
  // connection that this consumer alone owns. Non-blocking helpers like
  // publish()/deadLetter still go via the shared singleton — those don't
  // contend for the connection and there's no reason to multiply them.
  const redis = getRedis().duplicate();

  const ensureGroup = async (): Promise<void> => {
    try {
      await redis.xgroup('CREATE', opts.stream, opts.group, '$', 'MKSTREAM');
      console.log(`streams: created group ${opts.group} on ${opts.stream}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) throw err;
    }
  };

  const deadLetter = async (messageId: string, fields: Record<string, string>): Promise<void> => {
    if (!opts.dlq) return;
    await publish(opts.dlq, { ...fields, originalId: messageId, deadLetteredAt: String(Date.now()) });
  };

  /**
   * Reclaim messages idle longer than `reclaimStaleMs`. For each reclaimed
   * entry, check delivery count — if it exceeds `maxDeliveries`, move it to
   * the DLQ (if configured) and XACK. Otherwise XCLAIM it to this consumer
   * and return it to the processing loop.
   */
  const reclaimStale = async (): Promise<Array<[string, Record<string, string>]>> => {
    // XPENDING <stream> <group> IDLE <ms> - + <count>
    const pending = (await redis.xpending(
      opts.stream,
      opts.group,
      'IDLE',
      reclaimStaleMs,
      '-',
      '+',
      count,
    )) as Array<[string, string, number, number]>;

    if (!Array.isArray(pending) || pending.length === 0) return [];

    const out: Array<[string, Record<string, string>]> = [];
    for (const entry of pending) {
      const [messageId, _consumer, _idleMs, deliveryCount] = entry;
      if (deliveryCount > maxDeliveries) {
        // Fetch the payload for forensics regardless of whether a DLQ is
        // configured — both paths need it (DLQ for preservation, drop path
        // for the Sentry-visible error log). If this read fails we still
        // XACK and log the drop; logging must never block the backstop.
        let fields: Record<string, string> = {};
        let payloadSnippet = '(xrange failed)';
        try {
          const read = (await redis.xrange(opts.stream, messageId, messageId)) as Array<
            [string, string[]]
          >;
          fields = read[0] ? fieldsToRecord(read[0][1]) : {};
          const full = JSON.stringify(fields);
          payloadSnippet = full.length > 300 ? full.slice(0, 300) + '…' : full;
        } catch (xrangeErr) {
          // A DLQ entry without its original payload is worthless — the whole
          // point of the DLQ is payload preservation for later inspection.
          // Rethrow so the loop-level reclaim-error handler keeps the entry in
          // the PEL for a retry once xrange recovers. For the DLQ-less drop
          // path, logging must never block the XACK backstop, so we swallow.
          if (opts.dlq) throw xrangeErr;
          // (DLQ-less path: continue to XACK and log with "(xrange failed)")
        }

        if (opts.dlq) {
          await deadLetter(messageId, fields);
          await redis.xack(opts.stream, opts.group, messageId);
          console.warn(
            `streams: ${opts.stream}/${messageId} exceeded ${maxDeliveries} deliveries → DLQ`,
          );
        } else {
          // No DLQ configured — the message is permanently dropped. This is
          // the intended backstop for poison pills on DLQ-less consumers
          // (stream:scan-trigger, stream:delete-notify), but it must be
          // observable. A dropped scan-trigger = a lost ingest for that
          // upload until the 24 h full rescan (the upload never scanned →
          // stuck "Processing 1 file" banner), because the drop was
          // silent/mislabeled as "→ DLQ" (no DLQ configured). console.error
          // is Sentry-visible; console.warn is not.
          await redis.xack(opts.stream, opts.group, messageId);
          console.error(
            `streams: DROPPED ${opts.stream}/${messageId} — exceeded ${maxDeliveries} deliveries` +
            ` (no DLQ configured; group=${opts.group}; deliveries=${deliveryCount})` +
            ` payload=${payloadSnippet}`,
          );
        }
        continue;
      }
      // XCLAIM to take ownership, then the returned entries feed back into
      // the normal processing path below.
      const claimed = (await redis.xclaim(
        opts.stream,
        opts.group,
        consumer,
        reclaimStaleMs,
        messageId,
      )) as Array<[string, string[]]>;
      for (const [id, fields] of claimed) {
        out.push([id, fieldsToRecord(fields)]);
      }
    }
    return out;
  };

  const processOne = async (messageId: string, fields: Record<string, string>): Promise<void> => {
    // Fast path: skip the per-message XPENDING delivery-count lookup.
    // reclaimStale() walks the pending list every ~30s and handles the
    // DLQ-after-N-retries case there, so paying a Redis round-trip on
    // every successful message (the common case) is pure overhead.
    try {
      const payload = parse(fields);
      await opts.handler(payload, { stream: opts.stream, messageId, deliveryCount: 1 });
      await redis.xack(opts.stream, opts.group, messageId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // HandledTransientError signals "handler already classified + logged this
      // at info-level"; the throw exists only to skip XACK so reclaim/DLQ still
      // applies. Surfacing it to Sentry doubles the noise the handler tried to
      // silence — log at console.log so captureConsoleIntegration skips it.
      // Uncaught errors (handler bug, unclassified failure) still hit console.error.
      if (err instanceof HandledTransientError) {
        console.log(`streams: handler transient retry for ${opts.stream}/${messageId}: ${msg}`);
      } else {
        console.error(`streams: handler failed for ${opts.stream}/${messageId}:`, msg);
      }
      // Leave in PEL — reclaimStale will retry or DLQ after maxDeliveries.
    }
  };

  /**
   * Process `batch` with at most `concurrency` handlers in flight. Workers pull
   * from a shared index, so a slow entry doesn't block the rest of the batch.
   */
  const runBatch = async (batch: Array<[string, Record<string, string>]>): Promise<void> => {
    if (batch.length === 0) return;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const i = next++;
        if (i >= batch.length) return;
        const [id, fields] = batch[i];
        await processOne(id, fields);
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, worker);
    await Promise.all(workers);
  };

  const loop = async (): Promise<void> => {
    await ensureGroup();
    let sinceReclaim = 0;

    while (!stopped) {
      // Every ~6 loops or ~30s (whichever comes first), reclaim stale PEL.
      let reclaimed: Array<[string, Record<string, string>]> = [];
      if (sinceReclaim++ >= 6) {
        sinceReclaim = 0;
        try {
          reclaimed = await reclaimStale();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`streams: reclaim error on ${opts.stream}:`, msg);
        }
      }
      await runBatch(reclaimed);

      // XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK <ms> STREAMS <stream> >
      // `read` is assigned in the try block or the catch `continue`s out of the
      // iteration before any use. Declaring without an initializer keeps
      // ESLint's no-useless-assignment happy while preserving the semantics.
      let read: Array<[string, Array<[string, string[]]>]> | null;
      try {
        read = (await redis.xreadgroup(
          'GROUP', opts.group, consumer,
          'COUNT', count,
          'BLOCK', blockMs,
          'STREAMS', opts.stream,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`streams: xreadgroup error on ${opts.stream}:`, msg);
        // Back off briefly so a Redis outage doesn't spin the CPU.
        await sleepOrStop(1000, stopPromise);
        continue;
      }

      if (!read) continue;
      for (const [, entries] of read) {
        const batch = entries.map<[string, Record<string, string>]>(([id, fields]) => [id, fieldsToRecord(fields)]);
        await runBatch(batch);
      }
    }

    if (stopResolve) stopResolve();
  };

  loop().catch((err) => {
    console.error(
      `streams: consumer loop crashed for ${opts.stream}:`,
      err instanceof Error ? err.message : err,
    );
    if (stopResolve) stopResolve();
  });

  return {
    async stop() {
      stopped = true;
      await stopPromise;
      // Release the per-consumer connection. quit() drains in-flight
      // commands cleanly; if Redis is unreachable we fall back to a hard
      // disconnect so shutdown still completes within the SIGTERM grace.
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldsToRecord(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[fields[i]] = fields[i + 1];
  }
  return out;
}

/**
 * Walk a stream's consumer list and drop entries that look like leftovers
 * from old pods. Returns counts for logging.
 *
 * No-ops when the stream or group doesn't exist (returns `{ removed: 0,
 * kept: 0 }`) — first invocation on a fresh deployment is harmless.
 */
export async function cleanupStaleConsumers(
  stream: string,
  group: string,
  idleThresholdMs: number,
): Promise<{ removed: number; kept: number; total: number }> {
  const redis = getRedis();

  let raw: unknown;
  try {
    // ioredis: redis.xinfo('CONSUMERS', stream, group) returns an array of
    // arrays; each inner array is a flat name-value list (`['name', 'foo',
    // 'pending', 0, 'idle', 12345, ...]`).
    raw = await redis.xinfo('CONSUMERS', stream, group);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NOGROUP') || msg.includes('no such key')) {
      return { removed: 0, kept: 0, total: 0 };
    }
    throw err;
  }
  if (!Array.isArray(raw)) return { removed: 0, kept: 0, total: 0 };

  let removed = 0;
  let kept = 0;
  for (const entry of raw) {
    if (!Array.isArray(entry)) { kept++; continue; }
    const flat = entry.map(v => String(v));
    const fields = fieldsToRecord(flat);
    const name = fields['name'];
    const pending = parseInt(fields['pending'] ?? '0', 10);
    const idleMs = parseInt(fields['idle'] ?? '0', 10);
    if (!name) { kept++; continue; }
    if (pending === 0 && idleMs > idleThresholdMs) {
      try {
        await redis.xgroup('DELCONSUMER', stream, group, name);
        removed++;
      } catch (err) {
        // DELCONSUMER returns the count of orphaned pending messages on
        // success; ioredis only throws on protocol errors. Either way,
        // log and continue — no single consumer is worth aborting the sweep.
        console.warn(
          `streams: DELCONSUMER ${name} from ${stream}/${group} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        kept++;
      }
    } else {
      kept++;
    }
  }

  if (removed > 0) {
    console.log(
      `streams: cleanup ${stream}/${group} — removed ${removed} stale ` +
      `consumer(s) (idle>${idleThresholdMs}ms, pending=0), kept ${kept}`,
    );
  }
  return { removed, kept, total: removed + kept };
}

/**
 * Fire-and-forget periodic cleanup. Call once per (stream, group) pair from
 * a long-lived process (scanner-entry, thumbnail-worker-entry). Returns a
 * cancel function that stops both the initial timeout and the periodic
 * interval — safe to call from process shutdown handlers.
 *
 * Defaults: 1-hour interval, 24-hour idle threshold. The first cleanup
 * fires after 60 s so `consume()`'s `ensureGroup` finishes first on a
 * cold start.
 */
export function scheduleStaleConsumerCleanup(
  stream: string,
  group: string,
  opts: { idleThresholdMs?: number; intervalMs?: number; firstRunDelayMs?: number } = {},
): () => void {
  const idleThresholdMs = opts.idleThresholdMs ?? 24 * 60 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const firstRunDelayMs = opts.firstRunDelayMs ?? 60_000;

  const tick = (): void => {
    cleanupStaleConsumers(stream, group, idleThresholdMs).catch(err =>
      console.error(
        `streams: stale consumer cleanup ${stream}/${group} failed:`,
        err instanceof Error ? err.message : String(err),
      ),
    );
  };

  const initial = setTimeout(tick, firstRunDelayMs);
  const interval = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}

function sleepOrStop(ms: number, stop: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    stop.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
