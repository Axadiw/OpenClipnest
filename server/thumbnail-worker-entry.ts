// Thumbnail Worker — standalone entrypoint.
// Consumes `stream:thumbnail`; for each job: fetch event+user, download video
// from S3, extract a frame via ffmpeg, upload the JPG, update the DB.
// At-least-once delivery via XREADGROUP + XACK-after-done; a handler throw
// skips XACK so XCLAIM reclaims, and the entry lands in the DLQ after
// `maxDeliveries`.

import './sentry.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipelineToFile, runFfmpegFromFile, streamToSparseFile, streamToBuffer, seedSparseFromBuffer } from './services/thumbnailFfmpeg.js';
import { initDb } from './db/index.js';
import { edition } from './edition.js';
import { installEdition } from './extensions.js';
import {
  getEventByIdForOwner,
  updateEventThumbnail,
  updateEventDuration,
  updateEventViewFrameRate,
  getMissingDurationEvents,
  THUMBNAIL_UNPLAYABLE,
  getFileMetadataByKey,
  incrementThumbnailAttempts,
  collapseEventView,
  recomputeEventsPlaybackReadyForFile,
  recomputeEventsPlaybackReadyForEvent,
} from './db/queries/events.js';
import { createNotification } from './db/queries/notifications.js';
import { publishPush } from './services/streamsClient.js';
import { getObject, putObject, headObject } from './services/s3.js';
import { deleteRecordingAllBuckets } from './services/fileLifecycle.js';
import { generateSidecarForFile, getDurationSecondsFromExistingSidecar } from './services/fmp4PatchWorker.js';
import {
  consume,
  scheduleStaleConsumerCleanup,
  clearThumbnailDedup,
  HandledTransientError,
  STREAM_THUMBNAIL_GENERATE,
  STREAM_DLQ_THUMBNAIL,
  STREAM_DELETE_NOTIFY,
  GROUP_THUMBNAIL_WORKERS,
  GROUP_EVENT_MANAGERS,
} from './services/streamsClient.js';
import { handleDeleteNotify, type DeleteNotify } from './services/deleteNotifyHandler.js';
import { CONFIG } from './config.js';
import { startHealthzServer } from './utils/healthz.js';
import {
  CONNECT_TIMEOUT_MARKER,
  recordConnectOutcome,
  socketPoolHealthCheck,
} from './utils/socketPoolWedge.js';

// Edition side effects (hooks, metrics recorder) — see server/extensions.ts.
installEdition(edition);

interface ThumbnailJob {
  eventId: string;
  ownerId: number;
  // True only for scanner fresh-discovery (ingest) jobs — gates the
  // new_recording push. Reconciler/backfill/repair jobs carry false so a
  // backlog drain can't announce. Absent field decodes to false (fail-safe).
  notify: boolean;
}

// Hard cap on attempts before forcing a tombstone. The atomic increment runs
// BEFORE any S3 work so crashes / connect-timeouts / OOM kills all count
// toward the budget, guaranteeing the reconciler loop terminates.
const THUMBNAIL_RETRY_BUDGET = 5;

// Range-GET escalation: head-only covers faststart MP4 (moov-at-front), then
// head+tail for moov-at-end, then full GET as worst-case fallback.
const THUMBNAIL_HEAD_BYTES = parseInt(process.env.THUMBNAIL_HEAD_BYTES || String(4 * 1024 * 1024), 10);
const THUMBNAIL_TAIL_BYTES = parseInt(process.env.THUMBNAIL_TAIL_BYTES || String(2 * 1024 * 1024), 10);

// `new_recording` is a "your camera just captured something" banner. The push
// fires when a thumbnail is generated for the FIRST time — but thumbnail jobs
// are also enqueued by the scan/reconcile backstop, which after a deploy can
// drain a whole backlog of old, never-thumbnailed recordings at once, and a
// camera reconnecting after an outage can upload hours of history. Without a
// recency gate that replays "New recording" for clips days old and spams every
// device. Backlogs are still thumbnailed — just silently. Tunable via env;
// default 6h comfortably covers upload + processing lag.
const NEW_RECORDING_PUSH_MAX_AGE_MS = parseInt(
  process.env.NEW_RECORDING_PUSH_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10,
);

// events.timestamp is the camera's wall-clock time (from the filename) stored
// as if it were UTC, so it is off from the real capture instant by the
// camera's UTC offset (−12 h … +14 h). Compared with the server clock directly,
// every recording from a camera west of UTC−6 would look older than the window
// and never announce, so the window is measured on the server's own arrival
// time and the stamp only gets a sanity bound. A stamp can trail the real time
// only on the western side, by at most 12 h — UTC−12, the largest offset
// magnitude behind UTC; a camera east of UTC stamps ahead of the arrival,
// which needs no allowance.
const MAX_CAMERA_CLOCK_LAG_MS = 12 * 60 * 60 * 1000;

/** What the recency gate looks at, both as ISO8601 strings. */
export interface RecordingTimes {
  /** When the recording reached the server (file_metadata.uploaded_at). */
  arrivedAt: string | null | undefined;
  /** The camera's stamp (events.timestamp) — local wall-clock time, see above. */
  capturedAt: string | null | undefined;
}

/**
 * True when a recording is recent enough to warrant a `new_recording` push:
 *  - it arrived within the window (server clock against server clock, so the
 *    camera's time zone cannot skew it — a job that waited in a backlog for
 *    hours stays silent), and
 *  - the camera recorded it shortly before it arrived: at most the window plus
 *    the largest lag of a camera clock (12 h), so a live clip from any time
 *    zone passes while history a reconnecting camera uploads days later does
 *    not. The price: a UTC camera's history recorded up to 18 h (the default
 *    6 h window + 12 h) before it arrives still announces. A stamp ahead of the arrival
 *    (east of UTC, or a fast camera clock) is fine.
 * A missing or unparseable time fails safe to `false` — better to drop one
 * banner than to spam a backlog. Exported for unit tests.
 */
export function isFreshRecordingForPush(
  times: RecordingTimes,
  now: number = Date.now(),
  maxAgeMs: number = NEW_RECORDING_PUSH_MAX_AGE_MS,
): boolean {
  const arrived = times.arrivedAt ? Date.parse(times.arrivedAt) : NaN;
  const captured = times.capturedAt ? Date.parse(times.capturedAt) : NaN;
  if (Number.isNaN(arrived) || Number.isNaN(captured)) return false;
  if (now - arrived > maxAgeMs) return false;
  return arrived - captured <= maxAgeMs + MAX_CAMERA_CLOCK_LAG_MS;
}

/**
 * When the event's recording reached the server: the newest `uploaded_at` of
 * the files behind its views — for an ingest job, the upload that published
 * it. Null when none is known or the lookup fails (the caller then stays
 * silent; a push is never worth failing the job). Exported for unit tests.
 */
export async function recordingArrivedAt(
  userUuid: string,
  views: ReadonlyArray<{ videoRelPath?: string | null }>,
): Promise<string | null> {
  let latest: number | null = null;
  try {
    for (const view of views) {
      if (!view.videoRelPath) continue;
      const fm = await getFileMetadataByKey(CONFIG.s3RecordingsBucket, `${userUuid}/${view.videoRelPath}`);
      const at = fm?.uploadedAt ? Date.parse(fm.uploadedAt) : NaN;
      if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
    }
  } catch (err) {
    console.warn(
      `Thumbnail worker: could not read the arrival time of ${userUuid}/${views[0]?.videoRelPath ?? '?'}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * Whether a finished thumbnail job should emit a `new_recording` push.
 *
 * Two independent gates, both required:
 *  - `job.notify` — the structural split. Only the scanner's fresh-discovery
 *    (ingest) path publishes with notify=true; every reconciler/backfill/repair
 *    path publishes notify=false, so a backlog drain can NEVER announce by
 *    construction (not by guard). A genuinely-fresh event recovered via the
 *    repair path is harmless: it already announced from its own ingest job.
 *  - `isFreshRecordingForPush` — the residual recency guard, for the case where
 *    the ingest path itself surfaces OLD files (a job that sat in a backlog, or
 *    a camera uploading its history) and so carries notify=true on a stale
 *    recording.
 *
 * Exported for unit tests.
 */
export function shouldAnnounceNewRecording(
  job: { notify: boolean },
  times: RecordingTimes,
  now: number = Date.now(),
): boolean {
  return job.notify && isFreshRecordingForPush(times, now);
}

// Socket-pool-wedge detector lives in utils/socketPoolWedge.ts — shared with
// the API's /healthz handler. `recordConnectOutcome` + `socketPoolHealthCheck`
// here are imports; the threshold and marker constants come from that module
// so every service uses the same recovery contract.
// Sentinel string embedded in the Error thrown by `runSidecarStage` when the
// fmp4 patch worker reports `result: 'transient-error'` (S3 PUT blip,
// NoSuchBucket, sidecar fetch hiccup). The outer catch in
// `processThumbnailJob` matches on this so the job re-throws → XCLAIM
// reclaims → next pod retries with a fresh socket pool, instead of getting
// permanently tombstoned. Keeping this as a string match (rather than a
// custom Error subclass) so it survives the `err instanceof Error ? err.message : String(err)`
// coercion path the catch already uses.
export const SIDECAR_TRANSIENT_MARKER = 'sidecar transient error';
// Sentinel for the "view uploaded later than its dual-view partner" race.
// Reolink dual-view events (`Back_00_<ts>.mp4` + `Back_01_<ts>.mp4`) often
// arrive seconds-to-minutes apart over FTPS, but the scanner pairs them in
// `events` from the filename pattern as soon as the first one lands. When the
// thumbnail worker runs before the second view's file_metadata row exists, it
// previously logged "no file_metadata … skipping" and silently marked the
// event done — the racy publish then sat behind the 600s SETNX dedup TTL,
// leaving the second view stuck on "Processing…" for up to ~10 minutes while
// the wide-side dedup key expired. The fix: clear the dedup key + throw with
// this marker so XCLAIM retries within 30s AND the next reconciler tick (≤1
// min) gets a fresh publish — whichever wins gets the work. Classified as
// transient so the outer catch re-throws instead of tombstoning a perfectly
// playable file.
export const SIDECAR_MISSING_VIEW_MARKER = 'sidecar missing view file_metadata';
// Postgres deadlock (SQLSTATE 40P01). The `pg` driver surfaces the server
// message verbatim, which always begins with "deadlock detected". When the
// worker's UPDATE on `events` loses a deadlock cycle (e.g. concurrent
// reprocessing burst against the same row) the row is NOT poisoned — the
// reconciler re-publishes and the next pod converges. Tombstone+notification
// here would be a false positive that the user sees in their feed.
export const DEADLOCK_MARKER = 'deadlock detected';
// Local `withTimeout` wrapper at the bottom of this file produces
// `"${label} timed out after ${ms}ms"` when ffmpeg/S3 work blows past
// THUMBNAIL_JOB_TIMEOUT_MS. That's a stalled-pod symptom (slow S3, hung
// socket pool) — XCLAIM should retry on a fresh pod. The trailing `ms` is
// the discriminator: thumbnailFfmpeg.ts's permanent ffmpeg-SIGKILL message
// is `"ffmpeg timed out after 60s and was killed"` (note `s`, not `ms`),
// so the regex below intentionally requires a digit run followed by `ms`.
const WITH_TIMEOUT_MARKER_RE = /timed out after \d+ms/;
// AWS SDK v3 surfaces `name: 'UnknownError'` (with empty .message that
// `String(err)` then renders as "UnknownError") when the smithy HTTP layer
// receives a response it cannot decode into a known service exception —
// e.g. TLS RST mid-stream, S3 returning a 5xx with malformed XML, transient
// IPv6/IPv4 fallback during connect. Without a marker the handler bubbled the
// SDK error past the inner try/catch via the `event.thumbnail` early-return
// path (runSidecarStage outside the main wrap), so streamsClient logged it
// at console.error and Sentry captured it. We treat the marker as transient
// because the worst case (truly permanent backend error) still tombstones
// via the per-job retry budget — at most THUMBNAIL_RETRY_BUDGET=5 retries
// before the missing-view collapse / outer permanent path takes over.
export const AWS_OPAQUE_ERROR_MARKER = 'UnknownError';
// @smithy/node-http-handler's socket-INACTIVITY timeout: "the request socket
// timed out after 10000 ms of inactivity (configured by client requestHandler)".
// The object is fine; the socket stalled — a fresh pod with a fresh pool
// succeeds. Note the SPACE before `ms`: WITH_TIMEOUT_MARKER_RE deliberately
// requires `\d+ms` with no space, so it can distinguish the local withTimeout
// wrapper from thumbnailFfmpeg's PERMANENT "timed out after 60s" message.
// That one-character gap let this message fall through to the permanent
// branch and tombstone a COMPLETE 100 MB recording as `unplayable` (both
// views, after the 2-attempt budget). Matching on the stem keeps it
// independent of the configured timeout value.
export const SOCKET_INACTIVITY_MARKER = 'request socket timed out';

/**
 * Outer-catch transient classifier — return true when the error message
 * indicates a retry-worthy condition, so the catch re-throws and XCLAIM
 * reclaims the job onto a fresh pod, bypassing the user-visible
 * "thumbnail_failed" notification path. Centralising the rules here keeps
 * the catch readable and makes future markers a one-liner addition.
 *
 * Cases:
 *  - CONNECT_TIMEOUT_MARKER: AWS SDK keep-alive socket pool wedge
 *  - SIDECAR_TRANSIENT_MARKER: fmp4 patch worker's S3 hiccup
 *  - SIDECAR_MISSING_VIEW_MARKER: dual-view upload race (second view not yet in file_metadata)
 *  - DEADLOCK_MARKER: Postgres 40P01 on `events` UPDATE
 *  - WITH_TIMEOUT_MARKER_RE: local 120s job-level withTimeout
 *  - AWS_OPAQUE_ERROR_MARKER: AWS SDK v3 "UnknownError" (undecodable HTTP response)
 *  - SOCKET_INACTIVITY_MARKER: smithy socket-inactivity timeout on a slow S3 read
 */
export function isTransientWorkerError(message: string): boolean {
  return (
    message.includes(CONNECT_TIMEOUT_MARKER) ||
    message.includes(SIDECAR_TRANSIENT_MARKER) ||
    message.includes(SIDECAR_MISSING_VIEW_MARKER) ||
    message.includes(DEADLOCK_MARKER) ||
    WITH_TIMEOUT_MARKER_RE.test(message) ||
    message.includes(SOCKET_INACTIVITY_MARKER) ||
    message === AWS_OPAQUE_ERROR_MARKER
  );
}

// ---------------------------------------------------------------------------
// handleBudgetExceededView — exported for unit testing
// ---------------------------------------------------------------------------

export interface BudgetExceededInput {
  eventId: string;
  ownerId: number;
  userUuid: string;
  encryptionSalt: string;
  /** View id to collapse (profile-defined string, e.g. '00' / '01'). */
  viewId: string;
  /** Full view list for the event; used to look up the rel_path for the
   *  collapsed view before its row is deleted. */
  views: Array<{ id: string; videoRelPath: string }>;
}

export interface BudgetExceededDeps {
  collapseEventView: (eventId: string, ownerId: number, viewId: string) => Promise<void>;
  /** headObject called with (bucket, key) — salt is already bound by the default impl. */
  headObject: (bucket: string, key: string) => Promise<unknown>;
  deleteRecordingAllBuckets: typeof deleteRecordingAllBuckets;
}

/**
 * After THUMBNAIL_RETRY_BUDGET is exceeded for a sidecar generation attempt,
 * drop the view attachment from the event so the surviving view can be
 * processed alone. If the underlying S3 object is also gone (typical for
 * "skasowane pliki ale wisi w processing" case), cascade-delete the
 * file_metadata rows so they don't linger in the user's "processing files"
 * view forever. If S3 still exists, leave the row — the CLASS D/E
 * unplayable path in fmp4PatchWorker handles malformed-MP4 cases.
 */
export async function handleBudgetExceededView(
  input: BudgetExceededInput,
  deps: BudgetExceededDeps = {
    collapseEventView,
    headObject: (bucket, key) => headObject(bucket, key, input.encryptionSalt),
    deleteRecordingAllBuckets,
  },
): Promise<{ collapsed: true; orphanCleaned: boolean }> {
  const relPath = input.views.find(l => l.id === input.viewId)?.videoRelPath ?? null;

  await deps.collapseEventView(input.eventId, input.ownerId, input.viewId);

  if (!relPath) return { collapsed: true, orphanCleaned: false };

  // Use the recordings bucket; file_metadata stores s3_key as `${userUuid}/${relPath}`.
  const bucket = CONFIG.s3RecordingsBucket;
  const key = `${input.userUuid}/${relPath}`;

  let s3Exists = true;
  try {
    await deps.headObject(bucket, key);
  } catch (err) {
    if (err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey')) {
      s3Exists = false;
    }
  }

  if (s3Exists) return { collapsed: true, orphanCleaned: false };

  try {
    await deps.deleteRecordingAllBuckets({
      ownerId: input.ownerId,
      recordingS3Key: key,
      reason: 'collapse-view',
    });
    return { collapsed: true, orphanCleaned: true };
  } catch (cascadeErr) {
    console.warn('[handleBudgetExceededView] orphan cascade failed', {
      eventId: input.eventId,
      key,
      err: cascadeErr instanceof Error ? cascadeErr.message : cascadeErr,
    });
    return { collapsed: true, orphanCleaned: false };
  }
}

/**
 * Force a thumbnail tombstone — sets THUMBNAIL_UNPLAYABLE sentinel + emits
 * a user-facing notification. Both writes are best-effort (caught + warned)
 * because the caller is already on a failure path; losing the notification
 * is preferable to throwing and re-queueing the same poison-pill.
 *
 * If the events.thumbnail UPDATE itself fails we skip the notification —
 * the row state isn't even tombstoned yet, so a "your video failed" toast
 * would be premature. The reconciler will retry this event next tick.
 */
async function forceTombstoneEvent(args: {
  eventId: string;
  ownerId: number;
  filename: string;
  notificationMessage: string;
  contextLabel: string;
}): Promise<void> {
  const { eventId, ownerId, filename, notificationMessage, contextLabel } = args;
  try {
    await updateEventThumbnail(eventId, ownerId, THUMBNAIL_UNPLAYABLE);
  } catch (markErr) {
    console.warn(
      `Thumbnail worker: failed to mark event unplayable (${contextLabel}):`,
      markErr instanceof Error ? markErr.message : String(markErr),
    );
    return;
  }
  // Under the new rule playback_ready no longer depends on the thumbnail, so
  // without this recompute a tombstoned event with ready files would stay
  // visible — the recompute flips playback_unplayable=TRUE which hides it.
  // Per-event recompute: O(elf rows for this event), not O(all owner events).
  try {
    await recomputeEventsPlaybackReadyForEvent(eventId);
  } catch (recomputeErr) {
    console.warn(
      `Thumbnail worker: playback recompute after tombstone failed (${contextLabel}):`,
      recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr),
    );
  }
  try {
    await createNotification(ownerId, 'thumbnail_failed', notificationMessage, {
      eventId, filename, locKey: 'notif.thumbnail_failed.body', locArgs: [filename],
    });
  } catch (notifyErr) {
    console.warn(
      `Thumbnail worker: failed to create thumbnail_failed notification (${contextLabel}):`,
      notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    );
  }
}

// Worker-level outcome recorder: delegates to the shared wedge detector.
// Kept as a thin wrapper so the call sites at the bottom of the worker
// (`recordJobOutcome(undefined)` / `recordJobOutcome(err)`) stay readable
// and call-site naming reflects "job", not generic "S3 op".
function recordJobOutcome(err: unknown): void {
  recordConnectOutcome(err);
}

// Fetch + ffmpeg-extract a thumbnail with Range-GET escalation: head →
// head+tail → full GET. Each stage tries seek=0.5s then seek=0 before
// escalating. Throws when the full-GET stage's ffmpeg ladder also fails —
// caller's outer catch handles connect-timeout pass-through and
// tombstoning. If `totalSize` is null we skip to full GET.
async function fetchAndExtractThumbnail(params: {
  bucket: string;
  s3Key: string;
  userSalt: string;
  totalSize: number | null;
  tmpInput: string;
  tmpThumb: string;
  contextLabel: string;
}): Promise<{ durationSec: number | null; strategy: 'head' | 'headtail' | 'full'; headBuf: Buffer | null }> {
  const { bucket, s3Key, userSalt, totalSize, tmpInput, tmpThumb, contextLabel } = params;
  // Head bytes captured during the 'head' stage so the sidecar stage can reuse
  // them instead of re-downloading the first 4 MB (head-fetch dedup).
  let capturedHead: Buffer | null = null;

  type Stage = { label: 'head' | 'headtail' | 'full'; fetch: () => Promise<void> };
  const stages: Stage[] = [];

  if (totalSize !== null && totalSize > 0 && THUMBNAIL_HEAD_BYTES > 0) {
    stages.push({
      label: 'head',
      fetch: async () => {
        const upper = Math.min(THUMBNAIL_HEAD_BYTES, totalSize) - 1;
        const { body } = await getObject(bucket, s3Key, userSalt, `bytes=0-${upper}`);
        // Buffer the head (instead of streaming straight to disk) so the sidecar
        // stage can reuse it; seed the sparse ffmpeg input from the same bytes.
        capturedHead = await streamToBuffer(body as Readable, THUMBNAIL_HEAD_BYTES + 1024);
        seedSparseFromBuffer(tmpInput, totalSize, capturedHead);
      },
    });
    if (totalSize > THUMBNAIL_HEAD_BYTES + THUMBNAIL_TAIL_BYTES && THUMBNAIL_TAIL_BYTES > 0) {
      stages.push({
        label: 'headtail',
        fetch: async () => {
          // head bytes are still on disk from the previous stage — only fetch the tail.
          const tailStart = totalSize - THUMBNAIL_TAIL_BYTES;
          const { body } = await getObject(bucket, s3Key, userSalt, `bytes=${tailStart}-${totalSize - 1}`);
          await streamToSparseFile(body as Readable, tmpInput, totalSize, tailStart);
        },
      });
    }
  }
  stages.push({
    label: 'full',
    fetch: async () => {
      try { fs.unlinkSync(tmpInput); } catch { /* ignore — first call */ }
      const { body } = await getObject(bucket, s3Key, userSalt);
      await pipelineToFile(body as Readable, tmpInput);
    },
  });

  let lastErr: unknown = null;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isLast = i === stages.length - 1;

    // S3 fetch errors propagate immediately: connect-timeout MUST bubble for
    // the wedge detector; NoSuchKey/403 belong to the outer catch.
    await stage.fetch();

    try {
      const r = await runFfmpegFromFile(tmpInput, tmpThumb, '00:00:00.5');
      return { durationSec: r.durationSec, strategy: stage.label, headBuf: capturedHead };
    } catch (firstErr) {
      console.warn(
        `Thumbnail worker: stage=${stage.label} seek=0.5 failed for ${contextLabel}, retrying seek=0: ` +
        `${(firstErr instanceof Error ? firstErr.message : String(firstErr)).slice(0, 200)}`,
      );
      try {
        const r = await runFfmpegFromFile(tmpInput, tmpThumb, '00:00:00');
        return {
          durationSec: r.durationSec ?? (firstErr as { durationSec?: number | null }).durationSec ?? null,
          strategy: stage.label,
          headBuf: capturedHead,
        };
      } catch (secondErr) {
        lastErr = secondErr;
        if (isLast) throw secondErr;
        console.warn(
          `Thumbnail worker: stage=${stage.label} exhausted for ${contextLabel}, escalating: ` +
          `${(secondErr instanceof Error ? secondErr.message : String(secondErr)).slice(0, 200)}`,
        );
      }
    }
  }
  // unreachable: the last stage either returns or throws above.
  throw lastErr ?? new Error('fetchAndExtractThumbnail: no stages ran');
}

/**
 * For every non-null video view on this event, ensure the fmp4 patch sidecar
 * exists. Idempotent — generateSidecarForFile is no-op when the file is
 * already ready. Throws on transient errors so XCLAIM reclaims the parent
 * thumbnail job and the next iteration retries (per-file retry budget caps
 * total attempts so a poison-pill mp4 still terminates).
 *
 * After all sidecars succeed, recomputeEventsPlaybackReadyForFile is called
 * inside `markPlaybackPatchReady`, so the event flips visible automatically.
 * For events whose files were ALREADY ready before the event row existed,
 * the skipped-already-ready branch below performs that recompute instead
 * (gated on `event.playbackReady` to keep repair churn cheap).
 */
async function runSidecarStage(args: {
  event: {
    id: string;
    ownerId: number;
    /** events.playback_ready at job-fetch time — gates the skipped-already-ready recompute below. */
    playbackReady?: boolean;
    views: Array<{ id: string; videoRelPath: string }>;
  };
  user: { uuid: string; encryptionSalt: string };
  /** Head bytes already downloaded for the PRIMARY view's file during thumbnail
   *  extraction — reused to skip a duplicate head GET (head-fetch dedup). */
  primaryHeadBuf?: Buffer | null;
}): Promise<void> {
  const { event, user, primaryHeadBuf } = args;
  // One recompute covers the whole event (the per-file SQL re-evaluates every
  // attached view), so dual-view events must not pay for two transactions.
  let recomputedPlaybackReady = false;
  // The "primary" view is the first entry in views[] — that's the order
  // the profile registry defines (wide before zoom for Reolink). Sidecars
  // share the same source-derived duration across an event's views, so
  // reading from any one is equivalent; we pick the first for stability.
  const primaryRel = event.views[0]?.videoRelPath ?? null;
  for (const view of event.views) {
    const rel = view.videoRelPath;
    const s3Key = `${user.uuid}/${rel}`;
    const fm = await getFileMetadataByKey(CONFIG.s3RecordingsBucket, s3Key);
    if (!fm) {
      // Two scenarios collapse onto the same observable state:
      //
      //   (a) Dual-view upload race — scanner paired this view into `events`
      //       before its file_metadata row landed (Reolink uploads dual-view
      //       partners seconds-to-minutes apart). The partner arrives soon;
      //       a fast XCLAIM retry + reconciler republish resolves it.
      //
      //   (b) Permanent loss — auto-delete-oldest deleted one view's
      //       file_metadata but left the partner reference in events.
      //       getEventsMissingSidecar keeps matching via the surviving view's
      //       still-pending row, the worker keeps iterating over both views,
      //       the first NULL lookup keeps throwing transient → XCLAIM +
      //       reconciler loop forever, with hundreds of events per hour from a
      //       single user.
      //
      // (a) and (b) look identical for the first ~few attempts. Use the
      // existing thumbnail_attempts column as a shared retry budget — under
      // the cap, behave like (a) (clear dedup + throw transient → fast
      // retry); past the cap, declare (b) and collapse the event to single-
      // view by NULLing the dead view column. After collapse, the surviving
      // view's file_metadata row drops out of getEventsMissingSidecar once
      // its own sidecar runs, breaking the loop.
      const attempts = await incrementThumbnailAttempts(event.id, event.ownerId);
      if (attempts >= THUMBNAIL_RETRY_BUDGET) {
        const { orphanCleaned } = await handleBudgetExceededView({
          eventId: event.id,
          ownerId: event.ownerId,
          userUuid: user.uuid,
          encryptionSalt: user.encryptionSalt,
          viewId: view.id,
          views: event.views,
        });
        console.warn(
          `Sidecar stage: missing view file_metadata persisted past retry budget ` +
          `(${attempts}/${THUMBNAIL_RETRY_BUDGET}) for event ${event.id} key ${s3Key} — ` +
          `collapsed by removing view_id=${view.id}.` +
          (orphanCleaned ? ' Orphan file_metadata rows removed (S3 was already gone).' : ''),
        );
        try {
          // Reuse 'invalid_file' rather than adding a new NotificationKind:
          // the frontend already renders this kind with appropriate icon +
          // i18n string, and avoiding a new enum value here keeps the change
          // server-only (no frontend/types.ts + i18n update needed). The
          // user-facing `message` carries the full context.
          await createNotification(
            event.ownerId,
            'invalid_file',
            `One side of a dual-view recording ("${rel.split('/').pop() ?? rel}") could not be processed; the other side is unaffected.`,
            {
              eventId: event.id, missingView: rel, reason: 'view-collapsed',
              locKey: 'notif.invalid_file.viewCollapsed', locArgs: [rel.split('/').pop() ?? rel],
            },
          );
        } catch (notifyErr) {
          console.warn(
            `Sidecar stage: notification after view-collapse failed for event ${event.id}: ` +
            `${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
          );
        }
        // Return — not `continue`. If both views' FMs are simultaneously
        // missing, falling through to the next iteration would collapse the
        // second column on the same pass (same sticky `attempts >= budget`),
        // leaving the event with zero playable views. By returning we
        // collapse at most one view per job; the surviving view — if any —
        // is reprocessed on the next XCLAIM / reconciler tick when
        // getEventByIdForOwner reflects the NULL column.
        return;
      }
      // Under budget — assume (a). Clear the 600s SETNX dedup so the next
      // reconciler tick can publish a fresh job, AND throw a transient so
      // XCLAIM also retries within `reclaimStaleMs` (~30s). The marker is
      // classified by `isTransientWorkerError`, so the outer catch re-throws
      // instead of tombstoning a perfectly playable file.
      await clearThumbnailDedup(event.id);
      throw new Error(
        `${SIDECAR_MISSING_VIEW_MARKER} for key ${s3Key} (event ${event.id})`,
      );
    }
    let totalSize: number;
    try {
      const head = await headObject(CONFIG.s3RecordingsBucket, s3Key, user.encryptionSalt);
      totalSize = head.contentLength;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Some objects 4xx on HEAD+SSE-C even though their bytes are intact and
      // GET-able (observed on prod: a file looped HEAD→DLQ for ~6h while it was
      // perfectly downloadable). The size is already persisted at ingest
      // (file_metadata.file_size_bytes), and generateSidecarForFile reads the
      // recordings object via GET — never HEAD — so the live HEAD here is only a
      // freshness check. Fall back to the known size instead of looping to the
      // DLQ forever; only bail if we genuinely don't have a size.
      if (fm.fileSizeBytes > 0) {
        console.warn(
          `Sidecar stage: head failed for key ${s3Key} (event ${event.id}): ${msg.slice(0, 200)} — ` +
          `falling back to known size ${fm.fileSizeBytes} from file_metadata`,
        );
        totalSize = fm.fileSizeBytes;
      } else {
        console.warn(
          `Sidecar stage: head failed for key ${s3Key} (event ${event.id}) and no known size: ${msg.slice(0, 200)}`,
        );
        // No size to work with — bail; XCLAIM will retry the job.
        throw err;
      }
    }
    const out = await generateSidecarForFile(fm.id, {
      fileSize: totalSize,
      userSalt: user.encryptionSalt,
      // Reuse the thumbnail stage's head download for the primary view (same file).
      preFetchedHead: rel === primaryRel ? (primaryHeadBuf ?? undefined) : undefined,
    });
    // For class A files (Reolink fmp4) the head-only ffmpeg in the
    // thumbnail extraction stage produces a bogus duration: the 4 MB sparse
    // file only contains ~8 s of fragments and ffmpeg reports that as the
    // total duration. The authoritative duration is computed by
    // buildSidecarForFile while it walks every moof box. We persist it here,
    // overwriting any earlier head-stage value. Only the primary view's
    // duration is written to events.duration (both views are equal; keep
    // a single source of truth).
    const isPrimary = rel === primaryRel;
    switch (out.result) {
      case 'generated':
        console.log(
          `Sidecar stage: generated for fm=${fm.id} ` +
          `(${out.sidecarBytes} B, ${out.durationSeconds.toFixed(2)}s) — event ${event.id}`,
        );
        if (isPrimary && out.durationSeconds > 0) {
          await updateEventDuration(event.id, event.ownerId, out.durationSeconds);
        }
        if (out.frameRate != null) {
          await updateEventViewFrameRate(event.id, event.ownerId, rel, out.frameRate);
        }
        break;
      case 'skipped-already-good':
        console.log(`Sidecar stage: file is already playable as-is for fm=${fm.id} (event ${event.id})`);
        break;
      case 'skipped-already-ready':
        // No log spam — repeat job is a normal occurrence (XCLAIM, scanner re-publish).
        // For files patched before duration-from-sidecar was wired up, the DB
        // still holds the bogus head-stage value (e.g. 8.58 s for a 96 s clip).
        // Recover it cheaply from the existing sidecar's prelude (~5 KB GET).
        if (isPrimary) {
          const sec = await getDurationSecondsFromExistingSidecar(
            fm.id,
            user.encryptionSalt,
          );
          if (sec !== null && sec > 0) {
            await updateEventDuration(event.id, event.ownerId, sec);
          }
        }
        // Events (re)created AFTER their files were already patch-ready
        // (full-rescan displaced-event synthesis, slot heals, internal
        // rescans) never get a playback_ready recompute anywhere else:
        // `markPlaybackPatchReady`/`markPlaybackPatchUnplayable` only fire
        // from the generated / skipped-already-good / tombstoned branches,
        // and such an event always lands here. Without this recompute it
        // stays playback_ready=FALSE forever and is invisible in the grid
        // (thumbnail present, all files ready, never visible). Gated on the event NOT
        // already being ready because this branch is the common no-op path
        // under repair churn — an unconditional recompute would add one DB
        // transaction per view per repeat job.
        if (!event.playbackReady && !recomputedPlaybackReady) {
          recomputedPlaybackReady = true;
          await recomputeEventsPlaybackReadyForFile(fm.id);
        }
        break;
      case 'tombstoned':
        console.warn(`Sidecar stage: tombstoned fm=${fm.id} (event ${event.id}) — ${out.reason}`);
        break;
      case 'transient-error':
        // Surface to XCLAIM so the next pod gets a fresh socket pool. The
        // SIDECAR_TRANSIENT_MARKER prefix is what the outer catch matches
        // against to re-throw (transient) rather than tombstone (permanent).
        throw new Error(
          `${SIDECAR_TRANSIENT_MARKER} for fm=${fm.id}: ${out.reason}`,
        );
    }
  }
}

/**
 * Public entry — wraps `processThumbnailJobBody` with an outer transient
 * classifier so errors thrown from BEFORE the body's main try/catch
 * (DB fetches, the `event.thumbnail` early-return runSidecarStage call,
 * pre-try `incrementThumbnailAttempts` deadlocks, etc.) get the same
 * classification + Sentry-silencing treatment as errors from inside the
 * main try/catch. Without this layer an S3 SDK "UnknownError" bubbles
 * through the early-return path and surfaces as a Sentry issue — even though
 * the rest of the worker already routes transients to console.log.
 *
 * Classification rules live in `isTransientWorkerError`; transient throws
 * get wrapped in `HandledTransientError` so `streamsClient.processOne`
 * recognises them and stays out of Sentry. Unclassified throws fall
 * through to `processOne`'s console.error path — those are bona-fide
 * actionable errors and SHOULD show up in the inbox.
 */
export async function processThumbnailJob(job: ThumbnailJob): Promise<void> {
  try {
    await processThumbnailJobBody(job);
  } catch (err) {
    // Already wrapped by the inner catch — pass through to keep XCLAIM
    // semantics and avoid double-logging.
    if (err instanceof HandledTransientError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isTransientWorkerError(message)) {
      console.log(
        `Thumbnail worker: transient failure for event ${job.eventId} (outer): ${message}`,
      );
      throw new HandledTransientError(err);
    }
    // Permanent / unclassified — let streamsClient log at error so Sentry
    // captures the actionable signal. The body's own catch already handled
    // tombstoning for in-body permanents; this branch fires only when an
    // out-of-body throw escapes (rare).
    throw err;
  }
}

async function processThumbnailJobBody(job: ThumbnailJob): Promise<void> {
  const { eventId, ownerId } = job;

  const allUsers = await import('./db/queries/storage.js').then(m => m.getUsersForScan());
  const user = allUsers.find(u => u.id === ownerId);
  if (!user || !user.encryptionSalt) {
    console.warn(`Thumbnail worker: user ${ownerId} not found or missing salt, skipping ${eventId}`);
    return;
  }

  const event = await getEventByIdForOwner(eventId, ownerId);
  if (!event) {
    console.log(`Thumbnail worker: event ${eventId} not found for owner ${ownerId}`);
    return;
  }

  const videoRelPath = event.views[0]?.videoRelPath ?? null;
  if (!videoRelPath) {
    console.warn(`Thumbnail worker: event ${eventId} has no video, skipping`);
    return;
  }

  // Sidecar generation is its own stage; even when the thumbnail is already
  // set we still might need to ensure every attached file's sidecar exists.
  // The sidecar layer is idempotent — if the row is already ready it short-
  // circuits without bumping its retry budget. Run it before returning early
  // so existing-thumbnail events still converge on visibility after a
  // sidecar deploy.
  if (event.thumbnail) {
    console.log(`Thumbnail worker: event ${eventId} already has thumbnail; ensuring sidecars`);
    await runSidecarStage({
      event: { id: eventId, ownerId, playbackReady: event.playbackReady, views: event.views },
      user: { uuid: user.uuid, encryptionSalt: user.encryptionSalt },
    });
    return;
  }

  // Atomic increment + threshold check before any S3 work — past the budget
  // we force a tombstone + notification and return. mp4 stays playable.
  const attempts = await incrementThumbnailAttempts(eventId, ownerId);
  if (attempts >= THUMBNAIL_RETRY_BUDGET) {
    console.warn(
      `Thumbnail worker: event ${eventId} exceeded retry budget ` +
      `(${attempts}/${THUMBNAIL_RETRY_BUDGET}) — forcing tombstone. ` +
      `mp4 (if present) is preserved so the user can still play the clip.`,
    );
    await forceTombstoneEvent({
      eventId,
      ownerId,
      filename: videoRelPath,
      notificationMessage: `Recording "${videoRelPath.split('/').pop() ?? videoRelPath}" could not be played and no thumbnail could be generated.`,
      contextLabel: `retry-budget exhausted ${attempts}/${THUMBNAIL_RETRY_BUDGET}`,
    });
    return;
  }

  const s3Key = `${user.uuid}/${videoRelPath}`;

  // Skip >2 GB to bound /tmp; also captures size for the sparse Range-GET path.
  let totalSize: number | null = null;
  try {
    const { contentLength } = await headObject(CONFIG.s3RecordingsBucket, s3Key, user.encryptionSalt);
    if (contentLength > 2 * 1024 * 1024 * 1024) {
      console.warn(`Thumbnail worker: skipping ${s3Key} — file too large (${contentLength} bytes)`);
      return;
    }
    totalSize = contentLength;
  } catch { /* headObject failed — fetchAndExtractThumbnail will fall back to full GET */ }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipnest-thumb-'));
  const tmpThumb = path.join(tmpDir, 'thumb.jpg');

  const tmpInput = path.join(tmpDir, 'input.mp4');
  try {
    const { durationSec, strategy, headBuf: primaryHeadBuf } = await fetchAndExtractThumbnail({
      bucket: CONFIG.s3RecordingsBucket,
      s3Key,
      userSalt: user.encryptionSalt,
      totalSize,
      tmpInput,
      tmpThumb,
      contextLabel: `event ${eventId}`,
    });
    if (strategy !== 'head') {
      console.log(`Thumbnail worker: event ${eventId} extracted via stage=${strategy} (escalated past head)`);
    }

    if (durationSec !== null) await updateEventDuration(eventId, ownerId, durationSec);

    const thumbData = fs.readFileSync(tmpThumb);
    const thumbS3Key = `${user.uuid}/__generated__/${eventId}.jpg`;
    await putObject(CONFIG.s3ThumbnailsBucket, thumbS3Key, thumbData, user.encryptionSalt, thumbData.length);

    const thumbRef = `__s3_thumb__/${user.uuid}/${eventId}.jpg`;
    await updateEventThumbnail(eventId, ownerId, thumbRef);

    // A thumbnail now exists → the recording is viewable. Ping the user's
    // MOBILE devices with a thumbnail-bearing push. This is push-ONLY: we
    // deliberately publish straight to stream:push and do NOT call
    // createNotification, so `new_recording` is never written to the
    // notifications table. It must not appear in the in-app feed (web OR
    // mobile) — only as a live push banner; the persistent feed stays for
    // system alerts (storage, processing errors, etc.). The push worker still
    // applies the user's snooze + per-category prefs and mints the thumbnail
    // URL from `details`. Per-event idempotency is guaranteed by the
    // early-return at the top of this function (once an event has a thumbnail,
    // subsequent jobs short-circuit before here), so this runs at most once
    // per event.
    //
    // Announce gate (see shouldAnnounceNewRecording): only the scanner's
    // fresh-discovery (ingest) jobs may push, and only when the recording is
    // also fresh. Reconciler/backfill (repair) jobs carry notify=false, so a
    // backlog drain can't announce by construction; the recency check covers
    // the residual ingest-of-old-files case (a job stuck in a backlog / camera
    // history). Freshness is measured on the upload's arrival time — the
    // camera stamp is local wall-clock time. Old recordings still get their
    // thumbnail — just no banner. Own try/catch so a push failure never
    // poisons the (already durable) thumbnail.
    const times: RecordingTimes = {
      arrivedAt: job.notify ? await recordingArrivedAt(user.uuid, event.views) : null,
      capturedAt: event.timestamp,
    };
    if (!shouldAnnounceNewRecording(job, times)) {
      console.log(
        `Thumbnail worker: suppressing new_recording push for event ${eventId} ` +
        `(recorded ${times.capturedAt}, arrived ${times.arrivedAt ?? 'unknown'}, notify=${job.notify}) ` +
        '— repair job or stale recording',
      );
    } else {
      try {
        await publishPush({
          userId: String(ownerId),
          notificationId: '', // push-only — intentionally no persisted row
          kind: 'new_recording',
          title: 'New recording',
          message: `New recording from ${event.camera}`,
          // locKey/locArgs let new clients localize the banner (title-loc-key is
          // derived from `kind` by the push worker); `title`/`message` stay as the
          // literal fallback for clients that don't advertise loc-key support.
          details: JSON.stringify({
            eventId,
            camera: event.camera,
            locKey: 'notif.new_recording.body',
            locArgs: [event.camera],
          }),
        });
      } catch (notifyErr) {
        console.warn(
          `Thumbnail worker: new_recording push failed for event ${eventId}: ` +
          `${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
        );
      }
    }

    // After thumbnail is durable, ensure every attached file's playback
    // sidecar exists. Throws on transient errors so the whole job is
    // reclaimed via XCLAIM (acceptable — thumbnail re-extract is idempotent
    // and the early-return above skips it on retry).
    await runSidecarStage({
      // playbackReady is the value from job-fetch time — necessarily FALSE
      // here (the event had no thumbnail then, and playback_ready requires
      // one), so a skipped-already-ready outcome below still recomputes.
      // That is the "thumbnail job for an event whose files were patched
      // long ago" variant of the same prod incident.
      event: { id: eventId, ownerId, playbackReady: event.playbackReady, views: event.views },
      user: { uuid: user.uuid, encryptionSalt: user.encryptionSalt },
      primaryHeadBuf,
    });

    console.log(`Thumbnail worker: generated thumbnail for event ${eventId}`);
    recordJobOutcome(undefined);
  } catch (err) {
    recordJobOutcome(err);
    const message = err instanceof Error ? err.message : String(err);
    // Transient failures (S3 connect-timeout, sidecar-stage hiccup, Postgres
    // 40P01 deadlock, local 120s job-timeout, dual-view upload race): rethrow
    // so XCLAIM reclaims to a healthy pod. File-specific (deterministic)
    // failures get swallowed + notified to avoid DLQ churn. Transients MUST
    // NOT tombstone — that path fires a user-visible "could not be played"
    // notification even though the file is still being retried. See
    // `isTransientWorkerError` for the exact match list.
    //
    // Log-level split: both branches log under levels NOT captured by Sentry
    // for the thumbnail-worker (see sentry.ts — only 'error' is captured, and
    // we use 'log'/'warn' here). The k8s log retains the full ffmpeg stderr
    // for forensic diagnosis. The permanent branch already fires a user-
    // facing notification via forceTombstoneEvent, so the dev has nothing
    // actionable to do — repeated "ffmpeg invalid argument" from corrupted
    // camera uploads were pure noise. The transient branch is silenced the
    // same way.
    if (isTransientWorkerError(message)) {
      console.log(
        `Thumbnail worker: transient failure for event ${eventId} (${videoRelPath}): ${message}`,
      );
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      // Wrap so streamsClient.processOne logs at console.log (not error) —
      // XCLAIM still reclaims because the throw bypasses XACK. Without the
      // wrapper the outer streamsClient catch surfaced the same retry chatter
      // back to Sentry that this branch tried to silence.
      throw new HandledTransientError(err);
    }
    console.warn(`Thumbnail worker: permanent failure for event ${eventId} (${videoRelPath}):`, message);
    // Permanent failure — tombstone so the reconciler stops re-publishing.
    await forceTombstoneEvent({
      eventId,
      ownerId,
      filename: videoRelPath,
      notificationMessage: `Recording "${videoRelPath.split('/').pop() ?? videoRelPath}" could not be played and no thumbnail could be generated.`,
      contextLabel: 'outer permanent failure',
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- Startup ---

await initDb();
console.log('Thumbnail worker: database initialized');

// withTimeout guarantees forward progress when an upstream S3 stall would
// wedge a worker before ffmpeg's own SIGKILL fires.
const THUMBNAIL_CONCURRENCY = parseInt(process.env.THUMBNAIL_CONCURRENCY || '5', 10);
const THUMBNAIL_JOB_TIMEOUT_MS = parseInt(process.env.THUMBNAIL_JOB_TIMEOUT_MS || '120000', 10);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

consume<ThumbnailJob>({
  stream: STREAM_THUMBNAIL_GENERATE,
  group: GROUP_THUMBNAIL_WORKERS,
  dlq: STREAM_DLQ_THUMBNAIL,
  // Align the stream-level retry budget with the DB-level one
  // (`THUMBNAIL_RETRY_BUDGET=5`). Without this, `consume()` defaults to 3
  // (`streamsClient.ts:187`), so transient failures DLQ a job after 3
  // deliveries even though `incrementThumbnailAttempts` + the inline
  // `attempts >= THUMBNAIL_RETRY_BUDGET` tombstone gates would have
  // accepted up to 5. After a 3-delivery DLQ the SETNX dedup is still
  // active (600 s TTL), so the reconciler cannot re-publish until the
  // TTL expires — manifesting as "fresh event never gets a thumbnail"
  // in the 180 s smoke window on prod under stress-test load.
  maxDeliveries: THUMBNAIL_RETRY_BUDGET,
  count: THUMBNAIL_CONCURRENCY,
  concurrency: THUMBNAIL_CONCURRENCY,
  parse: (f) => ({ eventId: f.eventId ?? '', ownerId: Number(f.ownerId ?? 'NaN'), notify: f.notify === 'true' }),
  handler: async (job) => {
    if (!job.eventId || !Number.isFinite(job.ownerId)) {
      console.warn('Thumbnail worker: received malformed job:', job);
      return; // ack malformed — retry won't help
    }
    await withTimeout(
      processThumbnailJob(job),
      THUMBNAIL_JOB_TIMEOUT_MS,
      `thumbnail job ${job.eventId}`,
    );
  },
});


// ---------------------------------------------------------------------------
// stream:delete-notify — taken over from the retired event-manager Deployment (R3).
// High concurrency + larger batch absorbs an FTPS `rm -rf` of thousands of
// files in seconds — handler is DB-only (after the R2 S3-LIST removal), sub-10ms.
// Same group + stream as before (event-managers) so no consumer-group re-create
// needed; XACK semantics unchanged.
// ---------------------------------------------------------------------------
consume<DeleteNotify>({
  stream: STREAM_DELETE_NOTIFY,
  group: GROUP_EVENT_MANAGERS,
  concurrency: 50,
  count: 100,
  parse: (f) => ({ userUuid: f.userUuid ?? '', s3Key: f.s3Key ?? '' }),
  handler: async (payload) => {
    if (!payload.userUuid || !payload.s3Key) return;
    await handleDeleteNotify(payload);
  },
});

console.log('Thumbnail worker: subscribed to stream:delete-notify');

const HEALTHZ_PORT = parseInt(process.env.HEALTHZ_PORT || '3002', 10);
startHealthzServer(HEALTHZ_PORT, 'thumbnail-worker', socketPoolHealthCheck);

// Periodic stale-consumer cleanup — see scheduleStaleConsumerCleanup()
// docstring in services/streamsClient.ts. Each k8s pod restart leaks a
// consumer entry into the `thumbnail-workers` group; without this prune
// the group accumulates indefinitely.
scheduleStaleConsumerCleanup(STREAM_THUMBNAIL_GENERATE, GROUP_THUMBNAIL_WORKERS);
scheduleStaleConsumerCleanup(STREAM_DELETE_NOTIFY, GROUP_EVENT_MANAGERS);

console.log('Thumbnail worker: ready, waiting for jobs');

// Backfill duration for events that already have thumbnails but no duration.
// Run once on startup with a short delay to let the consumer loop settle.
//
// Reads from the patched sidecar's prelude (~5 KB GET) — the head-only ffmpeg
// path here would produce the same broken 8 s value that the worker used to
// write for class-A files (Reolink fmp4: mvhd duration=0, no mehd/mfra), so
// we go straight to the authoritative source the sidecar already encoded.
setTimeout(async () => {
  try {
    const { getUsersForScan } = await import('./db/queries/storage.js');
    const users = await getUsersForScan();
    for (const user of users) {
      if (!user.encryptionSalt) continue;
      const missing = await getMissingDurationEvents(user.id);
      for (const ev of missing) {
        // Pick the primary (first) view for the duration probe — sidecars
        // share the same source-derived duration across an event's views,
        // so reading from any one is equivalent.
        const videoRelPath = ev.views[0]?.videoRelPath;
        if (!videoRelPath) continue;
        const s3Key = `${user.uuid}/${videoRelPath}`;
        try {
          const fm = await getFileMetadataByKey(CONFIG.s3RecordingsBucket, s3Key);
          if (!fm) continue;
          const sec = await getDurationSecondsFromExistingSidecar(
            fm.id,
            user.encryptionSalt,
          );
          if (sec !== null && sec > 0) {
            await updateEventDuration(ev.id, user.id, sec);
          }
        } catch { /* skip — next worker startup will retry */ }
      }
    }
  } catch (err) {
    console.error('Thumbnail worker: duration backfill error:', err instanceof Error ? err.message : String(err));
  }
}, 30_000);
