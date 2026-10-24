/**
 * Metrics facade for the core.
 *
 * The core emits typed `observe*` / `record*` calls from its hot paths
 * (`services/s3.ts`, `routes/events/video.ts`, `utils/s3Stream.ts`, ingest,
 * playback …). What happens to them is the edition's business: Clipnest Cloud
 * installs a Prometheus recorder (server/cloud/observability/prometheus.ts)
 * and exposes `/metrics`; the self-hosted edition installs nothing, so every
 * call lands in the no-op recorder below. This module therefore owns NO metric
 * objects and pulls in no metrics library — only the label enums, the two
 * live-gauge providers, the pure bucketing helpers and the delegating calls.
 *
 * It deliberately imports NO application modules, so the emitting files depend
 * on it one-way — no import cycle is possible.
 *
 * LABEL HYGIENE (hard rule, privacy): every label value produced here is a
 * bounded, fixed enum. NO user ids, camera names, event ids, or request paths
 * beyond the fixed sets below. Unbounded labels both explode cardinality and
 * risk leaking identifiers into an operational store.
 */

// --- fixed label enums (keep bounded — see LABEL HYGIENE above) ---
/** Which /video serving path produced a metric. */
export type VideoPath = 'clean' | 'original' | 'patched';
/** S3 command family, bucketed to avoid unbounded command-name cardinality. */
export type S3Op = 'get' | 'head' | 'list' | 'put' | 'delete' | 'other';
/** Socket-pool bucket of an https/http keep-alive Agent. */
export type SocketState = 'active' | 'free' | 'queued';

/** Why a /video request failed (or downgraded). Bounded — see LABEL HYGIENE. */
export type VideoFailReason =
  | 'concurrency_cap'
  | 'quota_block'
  | 'sidecar_transient'
  | 'sidecar_fetch'
  | 'stale_sidecar'
  | 'range_unsatisfiable';

/**
 * How a clean-frame sidecar lookup was answered: from memory (`hit`), by reading the sidecar from the object store
 * (`miss`), or not at all because the recording has no sidecar (`absent`). Bounded — see LABEL HYGIENE.
 */
export type CleanSidecarCacheResult = 'hit' | 'miss' | 'absent';

/** File-kind bucket for an aborted upload. Bounded on purpose. */
export type UploadExt = 'mp4' | 'jpg' | 'other';

/**
 * Which write path created an `events` row.
 *
 * `ingest` is a recording arriving from a camera — the number a human means by
 * "recordings added today". `merge_heal` is a row the dual-view merge had to
 * split back out (a view that was wrongly absorbed getting its own standalone
 * event); it is a real row appearing, but it is bookkeeping rather than new
 * footage, so the two are kept apart rather than summed at the call site.
 *
 * The retired scanner paths (`replaceUserEvents` / `upsertEventsDelta`) are
 * deliberately NOT instrumented: they have had no non-test callers since the
 * R3 pipeline redesign, and their bulk `ON CONFLICT DO UPDATE` cannot tell an
 * insert from an update without a `RETURNING (xmax = 0)` probe that would only
 * ever measure dead code.
 */
export type EventCreateSource = 'ingest' | 'merge_heal';

/**
 * Why an `events` row disappeared.
 *
 * `merge` is internal churn — the dual-view keeper-swap deletes the displaced
 * row and creates an equivalent one in the same transaction — so a panel
 * showing "recordings the user lost" must exclude it. It is counted at all
 * only so created/deleted reconcile against the row count.
 */
export type EventDeleteReason =
  | 'user'          // deleted in the app
  | 'quota'         // auto-delete-oldest freeing space
  | 'retention'     // the user's own age-based retention rule
  | 'file_removed'  // underlying file deleted out-of-band (FTPS DELE / S3)
  | 'merge'         // dual-view keeper-swap churn — not user-visible loss
  | 'sweep';        // reconciler/zombie cleanup — CronJob-only, see prometheus.ts

// There is deliberately no `account_wipe` member: deleting an account removes
// its events through the `owner_id` FK cascade, so no application code observes
// the rows going away and no honest counter can be incremented for them.

/** Client that reported a playback event. Bounded — unknown values → `other`. */
export type ClientPlatform =
  | 'web'
  | 'ios'
  | 'ipados'
  | 'tvos'
  | 'macos'
  | 'android'
  | 'windows'
  | 'other';

const PLATFORMS: readonly ClientPlatform[] = [
  'web', 'ios', 'ipados', 'tvos', 'macos', 'android', 'windows', 'other',
];

/** Who generated a product event. Bounded — two members, forever. */
export type TrafficOrigin = 'organic' | 'synthetic';

export interface AgentStat { host: string; state: SocketState; count: number; }

// --- the recorder: what an edition plugs in -------------------------------

export interface MetricsRecorder {
  observeStreamThroughput(path: VideoPath, origin: TrafficOrigin, bytes: number, seconds: number): void;
  recordSlowConsumerKill(path: VideoPath): void;
  recordVideoServeFailure(reason: VideoFailReason): void;
  recordCleanSidecarCache(result: CleanSidecarCacheResult): void;
  observeS3Ttfb(op: S3Op, seconds: number): void;
  recordS3ConnectTimeout(): void;
  recordFtpsUploadAborted(ext: UploadExt, origin: TrafficOrigin): void;
  recordFtpsUploadCompleted(ext: UploadExt, origin: TrafficOrigin): void;
  recordFtpsLogin(origin: TrafficOrigin): void;
  observeHttpRequest(method: string, route: string, status: number, seconds: number): void;
  recordEventsCreated(source: EventCreateSource, origin: TrafficOrigin, n: number): void;
  recordEventsDeleted(reason: EventDeleteReason, origin: TrafficOrigin, n: number): void;
  recordPlaybackStarted(platform: ClientPlatform): void;
  recordPlaybackCompleted(platform: ClientPlatform): void;
  /** Present only when the edition exposes a scrape endpoint. */
  render?(): Promise<{ contentType: string; body: string }>;
}

/** Default: every call is dropped. What the self-hosted edition runs with. */
export const noopRecorder: MetricsRecorder = {
  observeStreamThroughput() {},
  recordSlowConsumerKill() {},
  recordVideoServeFailure() {},
  recordCleanSidecarCache() {},
  observeS3Ttfb() {},
  recordS3ConnectTimeout() {},
  recordFtpsUploadAborted() {},
  recordFtpsUploadCompleted() {},
  recordFtpsLogin() {},
  observeHttpRequest() {},
  recordEventsCreated() {},
  recordEventsDeleted() {},
  recordPlaybackStarted() {},
  recordPlaybackCompleted() {},
};

let recorder: MetricsRecorder = noopRecorder;

/** Installed once per process by `installEdition()`; undefined ⇒ no-op. */
export function installMetricsRecorder(r: MetricsRecorder | undefined): void {
  recorder = r ?? noopRecorder;
}

export function metricsRecorder(): MetricsRecorder {
  return recorder;
}

// --- live gauges: value pulled at scrape time via a provider the owner sets ---
// Providers are registered here (not on the recorder) so the owners can wire
// them regardless of edition; a recorder that scrapes reads them back through
// the getters.

let agentStatsProvider: () => AgentStat[] = () => [];
/** Owner (`services/s3.ts`) registers a snapshot fn read at scrape time. */
export function setS3AgentStatsProvider(fn: () => AgentStat[]): void {
  agentStatsProvider = fn;
}
export function getS3AgentStatsProvider(): () => AgentStat[] {
  return agentStatsProvider;
}

let videoInflightProvider: () => number = () => 0;
/** Owner (`middleware/concurrencyLimit.ts` via the edition) registers the counter. */
export function setVideoInflightProvider(fn: () => number): void {
  videoInflightProvider = fn;
}
export function getVideoInflightProvider(): () => number {
  return videoInflightProvider;
}

// --- pure bucketing helpers ------------------------------------------------

/** Bucket an arbitrary filename/extension into the bounded `ext` enum. */
export function uploadExtBucket(raw: string): UploadExt {
  const ext = raw.toLowerCase().replace(/^.*\./, '');
  return ext === 'mp4' || ext === 'jpg' ? ext : 'other';
}

/**
 * Bucket a client-supplied platform string into the bounded enum. Anything
 * unrecognised becomes `other` — a client must never be able to mint a new
 * label value by sending an arbitrary string.
 */
export function platformBucket(raw: unknown): ClientPlatform {
  if (typeof raw !== 'string') return 'other';
  const v = raw.toLowerCase();
  return (PLATFORMS as readonly string[]).includes(v) ? (v as ClientPlatform) : 'other';
}

// --- synthetic vs organic traffic ------------------------------------------
// Robot accounts (an uptime probe, a smoke test) can generate more product
// events than the humans on a small fleet, so an unlabelled "recordings added"
// is a reading of the instrumentation. The split is a LABEL, not a separate
// metric, and stays inside LABEL HYGIENE because the value is a two-member
// enum: the uuid is matched against a configured allow-list here and thrown
// away — it never reaches a metrics store.
//
// WHY A UUID LIST AND NOT A FLAG ON THE ACCOUNT: the classification has to hold
// in the thumbnail-worker (delete/notify) and the API alike, and both already
// carry `userUuid` at every call site. A DB column would mean a query on paths
// that are deliberately allocation-free, for a fact that changes about once a
// year.

let syntheticUuids: ReadonlySet<string> = parseSyntheticUuids(
  process.env.CLIPNEST_SYNTHETIC_USER_UUIDS,
);

function parseSyntheticUuids(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Override the synthetic-account list. Tests only — production reads
 * `CLIPNEST_SYNTHETIC_USER_UUIDS` at module load.
 */
export function setSyntheticUserUuids(raw: string | undefined): void {
  syntheticUuids = parseSyntheticUuids(raw);
}

/**
 * Classify an event by its owner. Anything not on the list is `organic` —
 * the safe default, because mislabelling a customer's recording as ours would
 * hide real activity, while the reverse merely leaves a known robot in the
 * customer column until the config is fixed.
 */
export function originFor(userUuid: string | null | undefined): TrafficOrigin {
  if (!userUuid) return 'organic';
  return syntheticUuids.has(userUuid.toLowerCase()) ? 'synthetic' : 'organic';
}

// --- delegating calls (the API the emitting files use) ---------------------

/**
 * Record a completed stream's throughput. `bytes`/`seconds` from the route.
 * `origin` is required and positional — pass `originFor(userUuid)`.
 */
export function observeStreamThroughput(path: VideoPath, origin: TrafficOrigin, bytes: number, seconds: number): void {
  recorder.observeStreamThroughput(path, origin, bytes, seconds);
}
/** Record a slow-consumer watchdog kill on a given serving path. */
export function recordSlowConsumerKill(path: VideoPath): void {
  recorder.recordSlowConsumerKill(path);
}
/** Record one /video request that failed (or downgraded) for a known reason. */
export function recordVideoServeFailure(reason: VideoFailReason): void {
  recorder.recordVideoServeFailure(reason);
}
/** Record how one clean-frame sidecar lookup was answered (memory = hit, object store = miss, no sidecar = absent). */
export function recordCleanSidecarCache(result: CleanSidecarCacheResult): void {
  recorder.recordCleanSidecarCache(result);
}
/** Record an S3 command's round-trip latency. */
export function observeS3Ttfb(op: S3Op, seconds: number): void {
  recorder.observeS3Ttfb(op, seconds);
}
/** Increment the hard connect-timeout counter. */
export function recordS3ConnectTimeout(): void {
  recorder.recordS3ConnectTimeout();
}
/** Record one FTPS upload the client abandoned mid-stream. Pass `originFor(userUuid)`. */
export function recordFtpsUploadAborted(ext: UploadExt, origin: TrafficOrigin): void {
  recorder.recordFtpsUploadAborted(ext, origin);
}
/** Record one successful FTPS login — the attempt side of the ingest funnel. Pass `originFor(userUuid)`. */
export function recordFtpsLogin(origin: TrafficOrigin): void {
  recorder.recordFtpsLogin(origin);
}
/** Record one upload that made it all the way through `/file-complete`. */
export function recordFtpsUploadCompleted(ext: UploadExt, origin: TrafficOrigin): void {
  recorder.recordFtpsUploadCompleted(ext, origin);
}
/** Record one completed HTTP request. `route` must be a bounded pattern. */
export function observeHttpRequest(method: string, route: string, status: number, seconds: number): void {
  recorder.observeHttpRequest(method, route, status, seconds);
}
/**
 * Record `n` newly created event rows. `n` is 0 on a pure-update upsert.
 * `origin` is required: a default would silently file a robot's churn under
 * customer activity. Pass `originFor(userUuid)`.
 */
export function recordEventsCreated(source: EventCreateSource, origin: TrafficOrigin, n = 1): void {
  recorder.recordEventsCreated(source, origin, n);
}
/** Record `n` deleted event rows. `origin` is required — see above. */
export function recordEventsDeleted(reason: EventDeleteReason, origin: TrafficOrigin, n = 1): void {
  recorder.recordEventsDeleted(reason, origin, n);
}
/** Record one playback start reported by a client. */
export function recordPlaybackStarted(platform: ClientPlatform): void {
  recorder.recordPlaybackStarted(platform);
}
/** Record one playback watched through to the end. */
export function recordPlaybackCompleted(platform: ClientPlatform): void {
  recorder.recordPlaybackCompleted(platform);
}
