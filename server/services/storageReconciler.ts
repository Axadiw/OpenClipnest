import { CONFIG } from '../config.js';
import { listObjectsStream, deleteObject, headObject } from './s3.js';
import {
  cleanupOldZombieEvents,
  countZombieEvents,
  getEventRefsByOwner,
  updateEventFiles,
  THUMBNAIL_UNPLAYABLE,
  getFileMetadataKeysByOwner,
  getEventByIdAnyOwner,
  getFileMetadataByKey,
  hasFileMetadataUnderPrefix,
  trackFileUpload,
} from '../db/queries/events.js';
import {
  getUsersForScan,
  getUserQuota,
  setDiskUsageAbsolute,
  createReconciliationRun,
  recordDiskCorrection,
  upsertOrphanObjects,
  getOrphansOlderThan,
  deleteOrphanObjectRow,
  withUserAdvisoryLock,
} from '../db/queries/storage.js';
import { getUserByUuid } from '../db/queries/users.js';
import { getAllUserUuids, getAllUserUuidsAnyStatus } from '../db/queries/users.js';
import { deleteNotificationsForEvent } from '../db/queries/notifications.js';
import { auditLog } from './audit.js';
import { deleteEventAndThumbnail } from './eventCleanup.js';
import { deleteS3AndMetadata } from './fileLifecycle.js';
import { publishScanTrigger } from './streamsClient.js';
import { reconcileUserQuota } from './quota-reconciler.js';

// Zombie events (wide_video IS NULL AND zoom_video IS NULL) older than this
// are deleted on every reconcile pass. The grace window absorbs transient
// state between FTPS DELE and the delete-notify handler finishing.
const ZOMBIE_GRACE_MINUTES = 5;

// Orphan S3 objects older than this many days get auto-purged on every
// reconcile pass. The grace window covers (a) a real user-deletion worker
// crash that left files behind — they'll be cleaned automatically without
// admin intervention; (b) a freshly-uploaded object that briefly looks
// orphan because the user row hadn't committed when the reconciler scanned.
// 7 days makes (b) impossible (UPSERT-then-list races resolve in seconds)
// while keeping (a) cleanups bounded.
const ORPHAN_AUTO_PURGE_DAYS = 7;

/**
 * Objects deleted per sweep — effectively "everything eligible".
 *
 * 200 made sense when the sweep ran 4x/day inside the audit. It does not now:
 * the sweep is DAILY, and the backlog left behind while auto-purge was a no-op
 * is ~59,000 objects — 295 days to drain at 200/run, i.e. never.
 *
 * The real bound is TIME, not a row count (see ORPHAN_PURGE_TIME_BUDGET_MS).
 * A count cap and a wall-clock cap together would just make the effective
 * limit whichever is smaller and harder to reason about, so the count is set
 * high enough to never bind and the clock does the work.
 */
const ORPHAN_AUTO_PURGE_BATCH = 1_000_000;

/**
 * Wall-clock ceiling for the purge phase, measured from the START of the whole
 * reconciliation (the scan runs first and shares the same job).
 *
 * Purging is unbounded work behind a bounded job: at ~40 ms per object
 * (re-verify + S3 delete + row delete) the current backlog is roughly 39
 * minutes, comfortably past the sweep's 1800 s deadline. Without this the job
 * would be SIGKILLed mid-drain — which loses nothing (each deletion commits
 * individually, the next run resumes) but reports Failed and hides the summary,
 * i.e. exactly the failure shape we just removed from the audit.
 *
 * Stopping ourselves at 25 min leaves ~5 min for the summary, Sentry flush and
 * Redis close. Whatever is left is simply picked up tomorrow.
 */
const ORPHAN_PURGE_TIME_BUDGET_MS = 25 * 60_000;

// Sentry threshold for `orphan_file_metadata_detected`. The cascade-delete
// safety net runs for every detected orphan (any count > 0), but we only
// surface a Sentry warn once a tick crosses this count — single-digit
// orphans are normal churn from concurrent delete paths racing the S3 LIST
// visibility window, and would spam the Sentry inbox. Real regressions show
// up as much larger spikes.
const ORPHAN_FILE_METADATA_WARN_MIN_COUNT = 10; // 15 minutes

interface PendingCorrection {
  userId: number;
  email: string;
  oldBytes: number;
  newBytes: number;
}

/**
 * Run one full storage reconciliation cycle:
 *
 *  1. Disk usage reconciliation — for each non-admin user, sum all S3 objects
 *     in the recordings bucket under their UUID prefix and compare with the
 *     disk_usage_bytes counter in the DB. Correct any discrepancy and log it.
 *
 *  2. Orphan scan — list every object in all S3 buckets and flag any whose
 *     UUID prefix does not match a known active user. Results are persisted
 *     (upserted) for admin review.
 *
 *  2b. Orphan auto-purge — orphan objects older than ORPHAN_AUTO_PURGE_DAYS
 *     (7 days) are deleted from S3, BUT only when their `{uuid}/` prefix
 *     belongs to no user row at all. The purge guard (`protectedUuids`,
 *     from getAllUserUuidsAnyStatus) excludes admin prefixes and any user
 *     stuck in a non-`active` deletion state, so only truly-unowned prefixes
 *     are eligible — the rest stay for admin review. The whole purge is gated
 *     by CONFIG.orphanAutoPurgeEnabled (default ENABLED): when disabled,
 *     orphans are still detected/upserted but never deleted.
 */
export interface ReconciliationOptions {
  /**
   * Run the S3 orphan sweep — per-object detection (steps 1c/1c2), the
   * cross-user prefix scan (step 2) and auto-purge (step 2b).
   *
   * Split out because the sweep and the rest of reconciliation want completely
   * different cadences. Everything else here feeds retention and quota tidy, so
   * it has to stay fresh (every 6 h). The sweep only ever feeds a purge that
   * then waits SEVEN DAYS from `firstSeenAt` — so scanning 4x a day was a ~28x
   * mismatch between how often we looked and how fast we acted. Spotting an
   * orphan a day later costs nothing against a 7-day grace window.
   *
   * That mismatch is what can kill the audit job: the sweep burns most of the
   * job's time budget, so retention / quota tidy / upload_events pruning
   * — all of which run after it — never execute at all.
   *
   * Defaults to `true`, so behaviour is unchanged for every existing caller;
   * only the 6-hourly audit opts out.
   */
  scanOrphans?: boolean;

  /**
   * Wall-clock budget for step 1 (the per-user disk/event reconciliation loop),
   * measured from the start of the run. When exceeded the loop stops at the
   * next user boundary and the run finishes normally; the remaining users are
   * picked up by the following run.
   *
   * WHY: step 1 is the last unbounded pass, it runs FIRST, and every pass that
   * deletes user data runs AFTER it (see audit-once.ts). It scales with total
   * object count, so a fixed job deadline is a shrinking budget: the pass
   * takes a growing share of an unchanged deadline until the audit dies on
   * DeadlineExceeded every run. The visible symptom is "a cleanup job is
   * late"; the actual one is that retention, quota tidy and the multipart
   * sweep have stopped executing.
   *
   * This is the same containment the orphan purge already has
   * (ORPHAN_PURGE_TIME_BUDGET_MS) — stop cleanly, log what was deferred, let
   * the passes that matter run. It is deliberately an OPTION defaulting to
   * unbounded, exactly like `scanOrphans`: the daily orphan sweep has a 1800s
   * deadline and must still walk every user, so fixing the audit must not
   * silently truncate the sweep.
   */
  stepOneBudgetMs?: number;
}

/**
 * How often the step-1 starting offset advances. Truncating the loop at the
 * same place every run would trade one failure for a worse one — the users at
 * the tail would never be reconciled at all, and their file_metadata is what
 * feeds retention's FIFO ordering. Rotating by wall-clock needs no new column
 * and evens coverage out across a day.
 */
const STEP1_ROTATION_PERIOD_MS = 6 * 3600_000;

export async function runStorageReconciliation(
  opts: ReconciliationOptions = {},
): Promise<void> {
  const { scanOrphans = true, stepOneBudgetMs } = opts;
  const start = Date.now();
  console.log(`Storage reconciliation: starting (orphan sweep ${scanOrphans ? 'ON' : 'OFF'})`);

  const [users, knownUuids, protectedUuidList] = await Promise.all([
    getUsersForScan(),
    getAllUserUuids(),
    getAllUserUuidsAnyStatus(),
  ]);
  // Purge GUARD: every user's UUID regardless of admin flag or deletion
  // status. Orphan DETECTION uses the active-only `knownUuids` (so objects
  // under an admin / mid-deletion prefix still get upserted for visibility),
  // but the destructive auto-purge must additionally require the prefix to be
  // absent here — otherwise an admin prefix or a user stuck mid-deletion for
  // >7 days would be classified as truly-unowned and its data deleted.
  const protectedUuids = new Set(protectedUuidList);

  const pendingCorrections: PendingCorrection[] = [];
  let eventsReconciled = 0;
  let eventsDeleted = 0;
  let orphansFound = 0;
  let orphanBytesTotal = 0;

  // Orphans are buffered and flushed in batches rather than upserted one at a
  // time — see upsertOrphanObjects for why (one round trip per object put the
  // job 500 s into a 540 s deadline).
  const orphanBuffer: Array<{ s3Bucket: string; s3Key: string; sizeBytes: number }> = [];
  const ORPHAN_FLUSH_AT = 500;
  const noteOrphan = async (s3Bucket: string, s3Key: string, sizeBytes: number): Promise<void> => {
    orphanBuffer.push({ s3Bucket, s3Key, sizeBytes });
    orphansFound++;
    orphanBytesTotal += sizeBytes;
    // Flush incrementally so peak memory stays bounded no matter how large the
    // pile gets; a full sweep can see hundreds of thousands of objects.
    if (orphanBuffer.length >= ORPHAN_FLUSH_AT) {
      await upsertOrphanObjects(orphanBuffer.splice(0, orphanBuffer.length));
    }
  };

  // -------------------------------------------------------------------------
  // Step 1 — per-user disk usage reconciliation + event↔S3 consistency.
  // Generated thumbnails live in a separate bucket and are server overhead —
  // they are not counted against the user's quota. Since we're already
  // paying for the S3 listing, reuse the key set to catch any DB events
  // whose wide_video / zoom_video / thumbnail paths no longer exist on
  // disk — the authoritative safety net for delete-notify messages that
  // were trimmed out of the stream before the consumer got to them.
  // -------------------------------------------------------------------------
  // Rotate the starting point so a budget-truncated run doesn't starve the
  // same tail users forever (see STEP1_ROTATION_PERIOD_MS). No-op when the
  // pass is unbounded — the sweep walks everyone anyway, and keeping its order
  // stable keeps its logs diffable.
  const scanOrder =
    stepOneBudgetMs !== undefined && users.length > 0
      ? (() => {
          const offset =
            Math.floor(start / STEP1_ROTATION_PERIOD_MS) % users.length;
          return [...users.slice(offset), ...users.slice(0, offset)];
        })()
      : users;

  let usersScanned = 0;
  let stepOneStoppedEarly = false;
  for (const user of scanOrder) {
    if (stepOneBudgetMs !== undefined && Date.now() - start > stepOneBudgetMs) {
      // Stop at a user boundary rather than mid-listing: each user's work is
      // self-contained and idempotent, so the next run just resumes from a
      // different offset. Everything after this loop — including every
      // destructive pass in audit-once — still gets to run.
      stepOneStoppedEarly = true;
      break;
    }
    usersScanned++;
    // Acquire the per-user LOCK_NS_QUOTA advisory lock that
    // `evictUserToFitPlan` (autoDelete) also holds. Without this,
    // Step 1's S3 listing snapshot can race with autoDelete: a key K
    // present at listing time gets evicted from S3 between
    // `recordingFullKeys.add(K)` and the matching `trackFileUpload(K)`,
    // which then re-creates the row UPSERT-style. The result is a row
    // that points at a key autoDelete just removed — caught by Step 2c
    // next tick, but for high-throughput users (continuous FTPS uploads
    // past quota) the cycle never settles. Skipping this user when
    // autoDelete is mid-eviction means we'll retry next tick (~1 min);
    // autoDelete finishes in seconds-to-minutes, so a back-to-back skip
    // is rare. The outer try-catch isolates a lock-acquire failure (DB
    // pool exhausted, transient) from breaking the loop for other users.
    let ranInsideLock: boolean | null;
    try {
      ranInsideLock = await withUserAdvisoryLock(user.id, async () => {
    try {
      // Stream the listing rather than collect
      // all 500k entries — for a heavy account this used to be ~250 MiB of
      // RAM held just to compute a sum + a Set, both of which fold cheaply
      // in stream. Build a Set of the per-user RELATIVE paths, not the full
      // S3 keys — event.wide_video / zoom_video / thumbnail columns store
      // paths WITHOUT the `{uuid}/` prefix (that's how the scanner normalises
      // them). Comparing full S3 keys against relative paths means every
      // single event reads as "missing" → the sweep wipes the user's
      // entire library on the first run. Strip the prefix once here.
      const userPrefix = `${user.uuid}/`;
      let actualBytes = 0;
      const recordingKeys = new Set<string>();
      // Full S3 keys (with uuid prefix) for the recordings bucket — consumed
      // by the Step 2c safety-net sweep which compares against file_metadata
      // s3_key (stored as full key). Built in the same listing loop as
      // recordingKeys to avoid a second S3 round-trip.
      const recordingFullKeys = new Set<string>();
      // Track 0-byte FTPS folder markers (keys ending in '/') separately.
      // libunftp's S3 backend translates each MKD into a 0-byte object with a
      // trailing slash. After all real files in a date-tree are deleted, the
      // markers stay forever. They don't count against quota (0 bytes), but
      // they pile up over time. Anything with no live siblings → orphan.
      const folderMarkers: { rel: string; key: string; size: number }[] = [];
      for await (const obj of listObjectsStream(CONFIG.s3RecordingsBucket, userPrefix)) {
        actualBytes += obj.size;
        const rel = obj.key.startsWith(userPrefix) ? obj.key.slice(userPrefix.length) : obj.key;
        if (rel.endsWith('/') && obj.size === 0) {
          folderMarkers.push({ rel, key: obj.key, size: obj.size });
          continue;
        }
        recordingKeys.add(rel);
        recordingFullKeys.add(obj.key);

        // Backfill / heal file_metadata: every recording S3 object becomes a
        // FIFO row keyed by S3 LastModified. ON CONFLICT preserves the first-
        // observed `uploaded_at` so live FTPS-stamped rows aren't reset.
        // Folder markers are excluded (they're not eviction targets).
        // The key is anchored under `userPrefix` by the listing itself (we
        // pass `userPrefix` to listObjectsStream), but assert the invariant
        // explicitly — if the SDK ever returns a key outside the prefix
        // (paginator bug, prefix encoding bug, etc.) we'd otherwise insert
        // a cross-user row that the FIFO eviction would later happily delete
        // from S3.
        if (!obj.key.startsWith(userPrefix)) {
          console.warn(
            `Storage reconciliation: skipping out-of-prefix key ${obj.key} ` +
            `for user ${user.uuid} (expected prefix ${userPrefix})`,
          );
        } else {
          try {
            const filename = rel.split('/').pop() || rel;
            // S3 LastModified is the authoritative FIFO key. ListObjectsV2
            // populates it for every real object, but if it's somehow
            // missing (S3-compat backend bug, partial response) fall back
            // to a HeadObject. Never silently fall through to NOW() — that
            // poisons FIFO ordering with row-materialization timestamps
            // instead of S3 PUT timestamps.
            let lastModified = obj.lastModified;
            if (!lastModified) {
              if (!user.encryptionSalt) {
                console.error(
                  `Storage reconciliation: ${obj.key} has no LastModified ` +
                  `from listing and user ${user.uuid} has no encryption salt ` +
                  `for HeadObject fallback — skipping`,
                );
                continue;
              }
              console.warn(
                `Storage reconciliation: ${obj.key} missing LastModified ` +
                `from listing — falling back to HeadObject`,
              );
              try {
                const head = await headObject(
                  CONFIG.s3RecordingsBucket, obj.key, user.encryptionSalt,
                );
                lastModified = head.lastModified;
              } catch (err) {
                console.error(
                  `Storage reconciliation: HeadObject fallback failed for ` +
                  `${obj.key}, skipping row:`,
                  err instanceof Error ? err.message : String(err),
                );
                continue;
              }
            }
            const upsert = await trackFileUpload(
              user.id,
              CONFIG.s3RecordingsBucket,
              obj.key,
              filename,
              obj.size,
              lastModified,
            );
            // Nudge the scanner whenever we materialise a NEW row. The scanner
            // listens on stream:scan-trigger and routes the s3Key through
            // notifyUpload(), which handles both root uploads
            // (`{uuid}/Foo_TS.mp4` → pendingExtraKeys) and out-of-window
            // backfills (`{uuid}/2026/03/25/Bar_TS.mp4` → pendingExtraDates).
            // Without this nudge the file would wait up to 24 h for the next
            // full rescan because delta-scan only lists today + 2 days back.
            // `inserted` comes from the `RETURNING …, (xmax = 0)` clause in
            // trackFileUpload (db.ts:3446-3464) — UPDATE-on-conflict yields
            // false, so existing rows revisited by later reconciler passes
            // do not re-publish.
            if (upsert.inserted) {
              try {
                await publishScanTrigger(user.uuid, obj.key);
              } catch (err) {
                console.warn(
                  `Storage reconciliation: scan-trigger publish failed for ${obj.key}:`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
          } catch (err) {
            console.warn(
              `Storage reconciliation: file_metadata upsert failed for ${obj.key}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      const quota = await getUserQuota(user.id);
      if (!quota) return true;

      // 1a — disk usage
      const storedBytes = quota.diskUsageBytes;
      if (storedBytes !== actualBytes) {
        const fullUser = await getUserByUuid(user.uuid);
        const email = fullUser?.email ?? user.uuid;
        console.log(
          `Storage reconciliation: correcting ${email} ` +
          `${formatBytes(storedBytes)} → ${formatBytes(actualBytes)} ` +
          `(delta ${actualBytes - storedBytes > 0 ? '+' : ''}${formatBytes(Math.abs(actualBytes - storedBytes))})`,
        );
        await setDiskUsageAbsolute(user.id, actualBytes);
        pendingCorrections.push({ userId: user.id, email, oldBytes: storedBytes, newBytes: actualBytes });
      }

      // 1b — event↔S3 consistency. Thumbnails live in the separate
      // thumbnails bucket, so a null-thumbnail here only says "the native
      // sidecar is gone" — not that the generated fallback is unreachable.
      // Treat thumbnail mismatches as updates, never as a reason to delete.
      //
      const events = await getEventRefsByOwner(user.id);
      for (const ev of events) {
        const missingViews = ev.views.filter(l => !recordingKeys.has(l.videoRelPath));
        // Thumbnail column holds one of:
        //   - null                                — worker hasn't run yet
        //   - '__unplayable__'                    — permanent tombstone
        //   - '__s3_thumb__/{uuid}/{id}.jpg'      — generated thumbnail
        //     (physically in the thumbnails bucket, NOT the recordings set)
        //   - '{uuid}/YYYY/MM/DD/Cam_00_ts.jpg'   — native view-00 sidecar
        //     uploaded by Reolink, lives in the recordings bucket
        // Only the last form should be checked against recordingKeys — any
        // other value must be preserved verbatim so tombstones don't get
        // reset into NULL (which re-enqueues the worker and spams a fresh
        // notification on every reconciler pass).
        const thumbIsExternal = ev.thumbnail !== null
          && (ev.thumbnail === THUMBNAIL_UNPLAYABLE || ev.thumbnail.startsWith('__s3_thumb__/'));
        const thumbMissing = ev.thumbnail !== null
          && !thumbIsExternal
          && !recordingKeys.has(ev.thumbnail);

        if (missingViews.length === 0 && !thumbMissing) continue;

        const survivingViews = ev.views.filter(l => recordingKeys.has(l.videoRelPath));

        if (survivingViews.length === 0) {
          // No playable media would remain → drop the row outright. Matches
          // handleDeleteNotify's terminal state. Also purge notifications
          // that point at this event — keeping them around just gives the
          // user an "Otwórz nagranie" button that 404s.
          //
          // Cascade: delete file_metadata rows for any video files that are
          // confirmed missing from S3. The view videoRelPath values are
          // relative paths; s3_key in file_metadata is the full `{uuid}/rel`
          // key. deleteS3AndMetadata is idempotent (NoSuchKey is swallowed),
          // so calling it for an already-absent S3 object is safe.
          //
          // Coverage for this cascade is in storageReconciler.step-2b.test.ts
          // (deferred placeholder) + Task 9 reconciler safety net unit tests
          // + Task 11 e2e test.
          for (const view of missingViews) {
            const s3Key = `${user.uuid}/${view.videoRelPath}`;
            try {
              await deleteS3AndMetadata({
                ownerId: user.id,
                s3Bucket: CONFIG.s3RecordingsBucket,
                s3Key,
                reason: 'reconciler-step-2b',
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn(
                `[reconciler.step2b] cascade delete failed eventId=${ev.id} s3Key=${s3Key} err=${errMsg}`,
              );
            }
          }
          await deleteEventAndThumbnail(ev.id, user.id, user.uuid, 'sweep');
          await deleteNotificationsForEvent(ev.id).catch(() => { /* non-fatal */ });
          eventsDeleted += 1;
        } else {
          // updateEventFiles takes a single rel_path per call; iterate per
          // missing view so each view row is dropped individually. The
          // thumbnail clear is folded into the same per-rel call since the
          // thumb path can match one of the view-file rels (native sidecar
          // case).
          for (const view of missingViews) {
            await updateEventFiles(ev.id, user.id, view.videoRelPath);
          }
          if (thumbMissing && ev.thumbnail) {
            await updateEventFiles(ev.id, user.id, ev.thumbnail);
          }
          eventsReconciled += 1;
        }
      }

      // 1c — orphan generated-thumbnail detection. Thumbnails live at
      // `{uuid}/__generated__/{eventId}.jpg` in the thumbs bucket and are
      // invisible to step 2's prefix scan because the UUID belongs to an
      // active user. If the matching event row is gone (FTPS delete-notify,
      // auto-delete-oldest pre-fix, manual delete pre-fix, scanner rebuilds),
      // the JPEG never gets cleaned. Upsert as orphan; auto-purge handles it
      // after the 7-day grace window.
      const liveEventIds = new Set(events.map(e => e.id));
      const thumbPrefix = `${user.uuid}/__generated__/`;
      if (scanOrphans) {
        try {
          for await (const obj of listObjectsStream(CONFIG.s3ThumbnailsBucket, thumbPrefix)) {
            if (!obj.key.endsWith('.jpg')) continue;
            const stem = obj.key.slice(thumbPrefix.length, -'.jpg'.length);
            if (liveEventIds.has(stem)) continue;
            await noteOrphan(CONFIG.s3ThumbnailsBucket, obj.key, obj.size);
          }
        } catch (err) {
          console.error(
            `Storage reconciliation: thumb orphan scan failed for ${user.uuid}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // 1c2 — orphan fmp4 patch sidecar detection. Sidecars live at
      // `{uuid}/<rel>.mp4.fmp4patch` in the dedicated sidecars bucket;
      // mirror the recordings layout so a sidecar is orphaned iff the
      // matching `<rel>.mp4` no longer exists under the user's recordings
      // prefix (FTPS DELE, auto-delete-oldest, retention sweep, manual
      // delete). Upsert as orphan; auto-purge handles it after the grace
      // window. Sidecars also lose visibility via Step 2 if the UUID
      // disappears (account deletion).
      const sidecarPrefix = `${user.uuid}/`;
      if (scanOrphans) {
        try {
          for await (const obj of listObjectsStream(CONFIG.s3SidecarsBucket, sidecarPrefix)) {
            // Resolve the parent recording rel for ANY sidecar suffix
            // (.fmp4patch / .clean_frame / .classic_moov / .frames / …). The old
            // `endsWith('.fmp4patch')` filter was blind to the other ~3/4 of
            // sidecars, which is why the admin panel reported 5651 orphans while
            // S3 actually held 200k+. See sidecarRecordingRel.
            const recRel = sidecarRecordingRel(obj.key.slice(sidecarPrefix.length));
            if (recRel === null) continue;
            if (recordingKeys.has(recRel)) continue;
            await noteOrphan(CONFIG.s3SidecarsBucket, obj.key, obj.size);
          }
        } catch (err) {
          console.error(
            `Storage reconciliation: sidecar orphan scan failed for ${user.uuid}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // 1d — orphan FTPS folder markers. A 0-byte key ending in '/' with no
      // live sibling files under the same prefix is leftover from a deleted
      // date tree. Upsert as orphan; auto-purge removes it after grace.
      if (scanOrphans) {
        for (const m of folderMarkers) {
          const hasSibling = setHasPrefix(recordingKeys, m.rel);
          if (hasSibling) continue;
          // m.size is 0 — contributes to the count but not to orphanBytesTotal.
          await noteOrphan(CONFIG.s3RecordingsBucket, m.key, m.size);
        }
      }

      // 1e — Step 2c safety net: find file_metadata rows whose S3 object is
      // gone (i.e. the cascade helper was never called — direct console delete,
      // pre-cascade code path, or a bug). Logs a Sentry-visible warn so
      // repeated fires surface as a regression signal.
      await runOrphanFileMetadataSweepForUser(
        user.id,
        new Map([[CONFIG.s3RecordingsBucket, recordingFullKeys]]),
      );
    } catch (err) {
      console.error(
        `Storage reconciliation: failed for user ${user.uuid}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return true;
    });
    } catch (err) {
      console.error(
        `Storage reconciliation: lock acquire failed for user ${user.uuid}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (ranInsideLock === null) {
      console.log(
        `Storage reconciliation: skipped user ${user.uuid} — autoDelete ` +
        `holds the per-user lock, will retry next tick`,
      );
    }

    // Quota-warning backstop: the inline upload path (disk-claim-and-tidy)
    // fires reconcileUserQuota on an upward 90/95% crossing, but a user who
    // plateaus just over the line — or whose inline trigger was lost to a pod
    // crash — would otherwise never be warned, since reconcileUserQuota is
    // otherwise only reached on admin plan changes. Run it here as the safety
    // net, OUTSIDE the per-user advisory lock so a slow warning email can't
    // stall eviction. Self-gated (auto-delete users + <90% return early) and
    // notification-deduped (hasRecentNotification), so per-tick re-runs are
    // cheap no-ops.
    try {
      await reconcileUserQuota(user.id);
    } catch (err) {
      console.error(
        `Storage reconciliation: quota-warning backstop failed for user ${user.uuid}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (stepOneStoppedEarly) {
    // Never truncate silently — a bounded pass that says nothing reads exactly
    // like a complete one, and "reconciled everyone" is the claim the FIFO
    // retention ordering downstream is trusting.
    console.log(
      `Storage reconciliation: step 1 hit its ${Math.round((stepOneBudgetMs ?? 0) / 1000)}s time ` +
      `budget after ${usersScanned}/${users.length} user(s) — ` +
      `${users.length - usersScanned} deferred to the next run`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 2 — cross-user orphan detection across both S3 buckets.
  // An orphan is any object whose top-level UUID prefix doesn't match a known
  // non-admin user. Records are upserted (idempotent) so repeated runs just
  // update last_seen_at and increment seen_count. Steps 1c/1d above also
  // upsert orphans found UNDER active-user prefixes (orphan thumbnails +
  // FTPS folder markers); together steps 1c/1d/2 cover the whole bucket.
  // -------------------------------------------------------------------------
  for (const bucket of scanOrphans
    ? [CONFIG.s3RecordingsBucket, CONFIG.s3ThumbnailsBucket, CONFIG.s3SidecarsBucket]
    : []) {
    try {
      // An empty prefix lists the WHOLE bucket;
      // the old `await listObjects(bucket, '')` could collect hundreds of
      // megabytes before we touched the first key. Streaming variant keeps
      // peak memory at one S3 page (~1000 keys).
      for await (const obj of listObjectsStream(bucket, '')) {
        const prefix = obj.key.split('/')[0];
        if (!isUuidLike(prefix)) continue;
        if (knownUuids.has(prefix)) continue;

        await noteOrphan(bucket, obj.key, obj.size);
      }
    } catch (err) {
      console.error(
        `Storage reconciliation: orphan scan failed for bucket "${bucket}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Flush whatever is left in the buffer BEFORE step 2b, so an orphan first
  // seen this run is already persisted when the purge query reads the table.
  if (orphanBuffer.length > 0) {
    await upsertOrphanObjects(orphanBuffer.splice(0, orphanBuffer.length));
  }

  // -------------------------------------------------------------------------
  // Step 2b — auto-purge orphan S3 objects older than the grace window.
  // Gated by CONFIG.orphanAutoPurgeEnabled (default ENABLED): when disabled we
  // skip deletion entirely but keep the orphan-tracking/upsert behavior above.
  // -------------------------------------------------------------------------
  let orphansAutoPurged = 0;
  let orphansAutoPurgeFailed = 0;
  if (!scanOrphans) {
    // Purge belongs to the sweep. Running it on the 6-hourly pass would delete
    // against orphan rows nothing had refreshed this run.
  } else if (!CONFIG.orphanAutoPurgeEnabled) {
    console.log(
      'Storage reconciliation: orphan auto-purge disabled ' +
      '(CLIPNEST_ORPHAN_AUTO_PURGE=false) — orphans tracked but not deleted',
    );
  } else {
  try {
    const oldOrphans = await getOrphansOlderThan(ORPHAN_AUTO_PURGE_DAYS, ORPHAN_AUTO_PURGE_BATCH);
    let purgeStoppedEarly = false;
    for (const o of oldOrphans) {
      if (Date.now() - start > ORPHAN_PURGE_TIME_BUDGET_MS) {
        // Stop cleanly rather than be killed mid-drain. Everything deleted so
        // far is already committed; the rest is picked up on the next sweep.
        purgeStoppedEarly = true;
        break;
      }
      const prefix = o.s3Key.split('/')[0];
      const kind = classifyOrphan(o.s3Bucket, o.s3Key, {
        thumbnails: CONFIG.s3ThumbnailsBucket,
        sidecars: CONFIG.s3SidecarsBucket,
        recordings: CONFIG.s3RecordingsBucket,
      });

      if (kind === 'unowned_prefix') {
        // Belt-and-braces: re-check the prefix isn't a freshly-provisioned user
        // whose row landed between getOrphansOlderThan and this loop.
        if (knownUuids.has(prefix)) continue;
        // Safety GUARD: never purge a prefix that
        // belongs to ANY user row — admin prefixes and users stuck in a
        // non-active deletion state are excluded from purge even though they
        // were upserted as orphans for admin visibility. Only truly-unowned
        // prefixes are eligible for deletion.
        if (protectedUuids.has(prefix)) continue;
      } else {
        // Per-object orphan under a live user. The prefix guard cannot apply
        // (the prefix is owned BY DEFINITION for this class), so prove the
        // object is unreferenced instead — freshly, against the database, at
        // the moment of deletion. This is a STRONGER test than the prefix
        // guard, not a weaker one: it asks the question that actually decides
        // whether the bytes are still reachable, and it re-asks it now rather
        // than trusting a set computed at the start of the scan.
        //
        // Anything we cannot positively prove is orphaned is SKIPPED — an
        // unparseable key, a lookup error, or a parent that reappeared all
        // mean "leave it alone and look again tomorrow".
        let stillOrphaned: boolean;
        try {
          stillOrphaned = await isStillOrphaned(kind, o.s3Key);
        } catch (err) {
          console.error(
            `Storage reconciliation: re-verification failed for ${o.s3Bucket}/${o.s3Key} — skipping:`,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
        if (!stillOrphaned) {
          // The parent came back (sidecar regenerated, event re-ingested).
          // Drop the stale orphan row so it stops being re-listed.
          await deleteOrphanObjectRow(o.id).catch(() => { /* retry next sweep */ });
          continue;
        }
      }
      try {
        await deleteObject(o.s3Bucket, o.s3Key);
        await deleteOrphanObjectRow(o.id);
        orphansAutoPurged++;
        auditLog('STORAGE_ORPHAN_AUTO_PURGED', {
          orphanId: o.id,
          bucket: o.s3Bucket,
          key: o.s3Key,
          sizeBytes: o.sizeBytes,
          firstSeenAt: o.firstSeenAt,
          // Which guard cleared this deletion — the forensic trail has to say
          // WHY it was allowed, not just that it happened.
          kind,
        });
      } catch (err) {
        orphansAutoPurgeFailed++;
        console.error(
          `Storage reconciliation: auto-purge failed for ${o.s3Bucket}/${o.s3Key}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (purgeStoppedEarly) {
      console.log(
        `Storage reconciliation: purge hit its ${ORPHAN_PURGE_TIME_BUDGET_MS / 60_000}-min time ` +
        `budget after ${orphansAutoPurged} deletion(s) — ${oldOrphans.length - orphansAutoPurged} ` +
        'eligible orphan(s) deferred to the next sweep',
      );
    }
  } catch (err) {
    console.error(
      'Storage reconciliation: orphan auto-purge query failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
  }

  // -------------------------------------------------------------------------
  // Step 3 — zombie-event cleanup. Rows where both video columns are NULL
  // can't be played; getEvents hides them from list views but they still
  // consume DB space. Delete any whose timestamp is older than the grace
  // window, then report how many still exist (should be near zero under
  // normal operation — a growing number signals delete-notify breakage).
  // -------------------------------------------------------------------------
  let zombiesCleaned = 0;
  let zombiesRemaining = 0;
  try {
    zombiesCleaned = await cleanupOldZombieEvents(ZOMBIE_GRACE_MINUTES);
    zombiesRemaining = await countZombieEvents();
  } catch (err) {
    console.error(
      'Storage reconciliation: zombie sweep failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const durationMs = Date.now() - start;

  // Persist the run record and attach correction details
  const runId = await createReconciliationRun(
    users.length,
    pendingCorrections.length,
    orphansFound,
    orphanBytesTotal,
    zombiesCleaned,
    zombiesRemaining,
    eventsReconciled,
    eventsDeleted,
    durationMs,
  );
  for (const c of pendingCorrections) {
    await recordDiskCorrection(runId, c.userId, c.email, c.oldBytes, c.newBytes);
  }

  const anythingFound = pendingCorrections.length > 0 || orphansFound > 0
    || zombiesCleaned > 0 || zombiesRemaining > 0
    || eventsReconciled > 0 || eventsDeleted > 0
    || orphansAutoPurged > 0 || orphansAutoPurgeFailed > 0;
  if (anythingFound) {
    console.log(
      `Storage reconciliation: done in ${durationMs}ms — ` +
      `${pendingCorrections.length} correction(s), ` +
      `${orphansFound} orphan(s) (${formatBytes(orphanBytesTotal)}), ` +
      `${orphansAutoPurged} auto-purged, ${orphansAutoPurgeFailed} purge fail(s), ` +
      `${zombiesCleaned} zombie(s) cleaned, ${zombiesRemaining} remaining, ` +
      `${eventsReconciled} event(s) reconciled, ${eventsDeleted} event(s) deleted`,
    );
  } else {
    console.log(`Storage reconciliation: done in ${durationMs}ms — everything consistent`);
  }
}

// ---------------------------------------------------------------------------
// Step 2c — orphan file_metadata safety net
// ---------------------------------------------------------------------------

/**
 * Find file_metadata rows for `ownerId` whose S3 object is absent from any of
 * the provided bucket→key sets and cascade-delete them via
 * `deleteS3AndMetadata`. This is the safety net for cases where the normal
 * cascade path (deleteS3AndMetadata at the delete site) was bypassed — e.g.
 * a direct S3 Console deletion, a pre-cascade code path, or a bug.
 *
 * Logs `orphan_file_metadata_detected` as a Sentry-visible `console.warn` so
 * that repeated fires surface as a regression signal. Quiet on the happy path.
 *
 * @param ownerId         Internal user ID (file_metadata.owner_id)
 * @param s3KeysPerBucket Map of bucket name → Set of FULL S3 keys currently
 *                        present on S3. Keys absent from the map are treated as
 *                        unknown buckets and all rows for them are considered
 *                        potential orphans — pass at least the recordings
 *                        bucket to avoid false positives.
 */
export async function runOrphanFileMetadataSweepForUser(
  ownerId: number,
  s3KeysPerBucket: Map<string, Set<string>>,
): Promise<{ orphansFound: number; orphansDeleted: number }> {
  // 10-minute grace window — long enough to outlast any S3 PUT → list
  // visibility delay plus a reconciler pass, even on a slow tick. Without
  // this guard, FTPS uploads landing concurrent with a reconciler pass
  // (file-uploaded inserts the row but the Step-1 listing was taken before
  // the S3 PUT became list-visible) get false-positive-flagged as orphans
  // and Step 2c cascade-deletes a valid just-uploaded file.
  const rows = await getFileMetadataKeysByOwner(ownerId, 10);
  const orphans = rows.filter((row) => {
    const set = s3KeysPerBucket.get(row.s3Bucket);
    // Bucket not in the map → we have no listing for it, skip (don't
    // false-positive rows for buckets not scanned this pass).
    if (!set) return false;
    return !set.has(row.s3Key);
  });

  if (orphans.length === 0) {
    return { orphansFound: 0, orphansDeleted: 0 };
  }

  // Sentry title must be stable across ticks so all firings group into a
  // single issue per user. count and sample go to a separate console.log so
  // service logs still carry the per-tick detail without exploding the
  // Sentry inbox into one issue per (userId, count, sample) combination.
  const sample = orphans
    .slice(0, 5)
    .map((o) => `${o.s3Bucket}/${o.s3Key}`)
    .join(',');
  if (orphans.length >= ORPHAN_FILE_METADATA_WARN_MIN_COUNT) {
    console.warn(
      `[reconciler] orphan_file_metadata_detected userId=${ownerId}`,
    );
  }
  console.log(
    `[reconciler.orphan_detail] userId=${ownerId} count=${orphans.length} sample=${sample}`,
  );

  let deleted = 0;
  for (const orphan of orphans) {
    try {
      await deleteS3AndMetadata({
        ownerId,
        s3Bucket: orphan.s3Bucket,
        s3Key: orphan.s3Key,
        reason: 'reconciler-safety-net',
      });
      deleted += 1;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[reconciler.safety_net] delete failed userId=${ownerId} key=${orphan.s3Key} err=${errMsg}`,
      );
    }
  }

  return { orphansFound: orphans.length, orphansDeleted: deleted };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

/**
 * Given a sidecar key relative to the user prefix, return the parent recording
 * rel-path it belongs to, or null if it isn't a recognisable sidecar.
 *
 * Sidecars are `{recordingRel}.<suffix>` and `recordingRel` always ends in
 * `.mp4` (.fmp4patch / .clean_frame / .classic_moov / .frames / future). We
 * anchor on the LAST `.mp4` so every suffix resolves to the same recording —
 * the old code matched only `.fmp4patch`, leaving the reconciler (and thus the
 * admin "S3 orphans" stat) blind to ~3/4 of the sidecar debris. A bare key with
 * no suffix after `.mp4` is the recording itself (not a sidecar) → null.
 */
export function sidecarRecordingRel(sidecarRel: string): string | null {
  const i = sidecarRel.lastIndexOf('.mp4');
  if (i < 0 || i + 4 === sidecarRel.length) return null;
  return sidecarRel.slice(0, i + 4);
}

/**
 * What KIND of orphan a tracked object is — which decides how we prove it is
 * safe to delete.
 *
 * There are two structurally different orphan classes here, and conflating
 * them is what broke auto-purge:
 *
 *  - `unowned_prefix`: the whole `{uuid}/` prefix has no user. Ownership is a
 *    property OF THE PREFIX, so the right test is "does any user own this
 *    prefix?" — the prefix guard.
 *
 *  - `orphan_thumb` / `orphan_sidecar`: a single object under a LIVE user
 *    whose parent is gone (steps 1c/1c2 exist precisely to find these — see
 *    their comments: "invisible to step 2's prefix scan because the UUID
 *    belongs to an active user"). Ownership is a property OF THE OBJECT, and
 *    the prefix guard is therefore always true for them, so they would pile up
 *    with `0 auto-purged`.
 *
 * Derived from bucket + key shape at purge time rather than stored in a
 * column. That is deliberate: the classification is then computed from the
 * CURRENT layout, and the referential re-check below runs against the CURRENT
 * database — neither can go stale the way a `kind` written days earlier could.
 */
export type OrphanKind =
  | 'orphan_thumb'
  | 'orphan_sidecar'
  | 'folder_marker'
  | 'unowned_prefix';

const THUMB_SEGMENT = '/__generated__/';

/**
 * Strict classifier. Anything that does not match a per-object shape EXACTLY
 * falls through to `unowned_prefix`, i.e. to the conservative prefix guard.
 * Mis-classifying toward the strict branch costs an uncleaned object;
 * mis-classifying the other way could delete a live one.
 */
export function classifyOrphan(
  s3Bucket: string,
  s3Key: string,
  buckets: { thumbnails: string; sidecars: string; recordings: string },
): OrphanKind {
  if (s3Bucket === buckets.thumbnails) {
    const i = s3Key.indexOf(THUMB_SEGMENT);
    if (i > 0 && s3Key.endsWith('.jpg')) return 'orphan_thumb';
  }
  if (s3Bucket === buckets.sidecars) {
    const slash = s3Key.indexOf('/');
    if (slash > 0 && sidecarRecordingRel(s3Key.slice(slash + 1)) !== null) {
      return 'orphan_sidecar';
    }
  }
  // FTPS folder marker — a 0-byte key ending in `/`, left behind when a date
  // tree is emptied. Step 1d detects these under LIVE users (same as 1c/1c2),
  // so they were stuck under the prefix guard exactly like thumbs and sidecars
  // were: 193 of them survived four consecutive sweeps at `0 auto-purged`.
  // Costs nothing in storage (0 bytes) but is re-listed on every sweep, and
  // leaving a known-broken class in place invites the next reader to conclude
  // the guard is meant to work this way.
  if (s3Bucket === buckets.recordings && s3Key.endsWith('/')) {
    const slash = s3Key.indexOf('/');
    // Must have a real path under the uuid — `{uuid}/` alone is the account
    // root, never a date-tree marker, and must not be treated as one.
    if (slash > 0 && slash < s3Key.length - 1) return 'folder_marker';
  }
  return 'unowned_prefix';
}

/** The event id a generated-thumbnail key refers to, or null if unparseable. */
export function thumbEventId(s3Key: string): string | null {
  const i = s3Key.indexOf(THUMB_SEGMENT);
  if (i <= 0 || !s3Key.endsWith('.jpg')) return null;
  const stem = s3Key.slice(i + THUMB_SEGMENT.length, -'.jpg'.length);
  return stem.length > 0 ? stem : null;
}

/**
 * Prove — against current database state — that a per-object orphan really is
 * unreferenced. Returns false for "still referenced" AND for "cannot tell";
 * the caller treats both as do-not-delete.
 *
 * This is the safety property the whole per-object branch rests on, so it is
 * deliberately written to fail CLOSED: every unparseable key, every missing
 * lookup result that could mean either thing, returns false.
 */
export async function isStillOrphaned(
  kind: Exclude<OrphanKind, 'unowned_prefix'>,
  s3Key: string,
): Promise<boolean> {
  if (kind === 'orphan_thumb') {
    const eventId = thumbEventId(s3Key);
    if (eventId === null) return false; // unparseable → refuse
    // Any owner: the event id already encodes the owner uuid, and a thumbnail
    // is referenced if ANY event row still points at that id.
    const ev = await getEventByIdAnyOwner(eventId);
    return ev === undefined;
  }

  if (kind === 'folder_marker') {
    // A marker is referenced iff ANY live recording still sits beneath it.
    // Guard the shape here too: deleting a marker whose key does not end in
    // `/` would turn a prefix test into a substring test and could match a
    // sibling directory. Classification already checks this — re-checking is
    // cheap and keeps the safety property local to the function that deletes.
    if (!s3Key.endsWith('/')) return false;
    const hasLive = await hasFileMetadataUnderPrefix(CONFIG.s3RecordingsBucket, s3Key);
    return !hasLive;
  }

  // orphan_sidecar — referenced iff its parent recording still has a
  // file_metadata row. Checking the DB rather than S3 is intentional: the DB
  // is what the app serves from, and a recording with no row is already
  // unreachable regardless of what is in the bucket.
  const parentKey = sidecarParentKey(s3Key);
  if (parentKey === null) return false; // unparseable → refuse
  const parent = await getFileMetadataByKey(CONFIG.s3RecordingsBucket, parentKey);
  return parent === null;
}

/** The recordings-bucket key a sidecar belongs to, or null if unparseable. */
export function sidecarParentKey(s3Key: string): string | null {
  const slash = s3Key.indexOf('/');
  if (slash <= 0) return null;
  const rel = sidecarRecordingRel(s3Key.slice(slash + 1));
  return rel === null ? null : `${s3Key.slice(0, slash)}/${rel}`;
}

/**
 * True if any element of `set` starts with `prefix`. Used by 1d to decide
 * whether a 0-byte folder marker still has a live sibling. O(n) — fine here
 * because typical recording sets are bounded per-user (auto-delete enforces
 * the quota cap) and the inner loop runs only once per orphan-marker batch.
 */
function setHasPrefix(set: Set<string>, prefix: string): boolean {
  for (const s of set) if (s.startsWith(prefix)) return true;
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
