// Transactional upload-completion ingest (spec §2, R1).
//
// Replaces the scan-based linking path for new uploads: one DB transaction
// inserts file_metadata (with explicit processing_state), parses the
// filename against the user's camera profiles, and creates or dual-view-
// merges the event + event_view_files rows. Serialized per (user, camera)
// with a transactional advisory lock so concurrent uploads from multiple
// FTPS replicas cannot race the merge decision.
import { sql } from 'drizzle-orm';
import { withTx, type Tx } from '../../db/index.js';
import { getEffectiveProfiles } from '../cameraProfileResolver.js';
import { parseS3Keys, VIDEO_EXTS } from './filenameParse.js';
import { buildEvents, dualViewRecordingsMatch } from '../scanner/eventBuilder.js';
import { upsertDuplicateFileNotification } from '../../db/queries/notifications.js';
// markPlaybackPatchReady and updateEventViewFrameRate are retained for Task 5
// (worker-side patch path); unused here after R2 inline removal.
import { markPlaybackPatchReady as _markPlaybackPatchReady, updateEventViewFrameRate as _updateEventViewFrameRate } from '../../db/queries/events.js';
import { recordEventsCreated, recordEventsDeleted, originFor } from '../../utils/metrics.js';
import type { CameraEvent } from '../../types.js';
import type { CameraProfile } from '../../config/cameraProfiles.js';

// Advisory-lock namespace for ingest merge decisions ('ings' in ASCII).
// Two-int form, same convention as RECOMPUTE_OWNER_LOCK_KEY1 in queries/events.ts.
const INGEST_LOCK_KEY1 = 0x696e6773;

export type CompleteUploadResult =
  | { created: boolean; state: 'not_applicable' | 'unrecognized' }
  | {
      created: boolean;
      state: 'pending_sidecar' | 'duplicate' | 'ready';
      eventId: string;
      ownerId: number;
      /** Events this upload CREATED by re-homing a displaced view out of a
       *  merge-artifact slot. Their file was already linked (often already
       *  `ready`), so nothing else ever queues a thumbnail for them — the caller
       *  must publish one per id alongside `eventId`. */
      rehomedEventIds?: string[];
    };

export interface CompleteUploadInput {
  userId: number;
  userUuid: string;
  s3Bucket: string;
  s3Key: string;
  originalFilename: string;
  fileSizeBytes: number;
  /** The client cut the transfer short; the object is a valid but SHORTER clip. */
  truncated?: boolean;
}

function videoExt(s3Key: string): boolean {
  if (s3Key.endsWith('/')) return false;
  const ext = s3Key.toLowerCase().replace(/.*\./, '');
  return (VIDEO_EXTS as readonly string[]).includes(ext);
}

export async function completeUpload(input: CompleteUploadInput): Promise<CompleteUploadResult> {
  const { userId, userUuid, s3Bucket, s3Key, originalFilename, fileSizeBytes } = input;
  const truncated = input.truncated ?? false;
  const userPrefix = `${userUuid}/`;

  // Fix E.3: guard against keys outside the user's own prefix
  if (!s3Key.startsWith(userPrefix)) throw new Error('completeUpload: s3Key outside user prefix');

  // Profile resolution does its own DB reads — keep it OUTSIDE the tx.
  const isVideo = videoExt(s3Key);
  const profiles = isVideo ? await getEffectiveProfiles(userUuid) : [];
  const parsed = isVideo
    ? parseS3Keys([{ key: s3Key, size: fileSizeBytes }], userPrefix, profiles)
    : [];
  const parsedEvent: CameraEvent | undefined =
    parsed.length > 0 ? buildEvents(userUuid, parsed).values().next().value : undefined;

  const terminalState: 'not_applicable' | 'unrecognized' | null = !isVideo
    ? 'not_applicable'
    : parsedEvent
      ? null
      : 'unrecognized';

  // Collects ids of events created by re-homing a displaced view (see
  // CompleteUploadResult.rehomedEventIds). Reset per tx attempt.
  let rehomed: string[] = [];
  const result = await withTx(async (tx) => {
    rehomed = [];
    // 1. file_metadata upsert — idempotent on (s3_bucket, s3_key). A camera
    //    retransmission must not duplicate the row or reset its state.
    //    xmax = 0 is true only for freshly inserted rows (Fix A.1).
    //    `truncated` DOES get overwritten on conflict (unlike processing_state):
    //    it describes the bytes currently in the bucket, and a retransmission
    //    replaces them. A camera that finally lands the file in full must clear
    //    the flag; a second cut-short attempt must re-set it.
    const inserted = await tx.execute<{ id: number; created: boolean }>(sql`
      INSERT INTO file_metadata
        (owner_id, s3_bucket, s3_key, original_filename, file_size_bytes, processing_state, truncated)
      VALUES
        (${userId}, ${s3Bucket}, ${s3Key}, ${originalFilename}, ${fileSizeBytes},
         ${terminalState ?? 'pending_sidecar'}, ${truncated})
      ON CONFLICT (s3_bucket, s3_key) DO UPDATE
        SET original_filename = EXCLUDED.original_filename,
            file_size_bytes = EXCLUDED.file_size_bytes,
            truncated = EXCLUDED.truncated
      RETURNING id, (xmax = 0) AS created
    `);
    const created = Boolean(inserted.rows[0]?.created);

    // Fix A.3: for terminal states decided this run, drive the fm row to the
    // terminal state without downgrading an already-'ready' file.
    if (terminalState) {
      if (terminalState === 'unrecognized') {
        // Age-based backoff so the 1-minute redrive can retry without waiting for
        // the 6h audit. Intervals widen as uploaded_at ages; beyond 7 days the
        // audit remains the backstop (next_retry_at = NULL → excluded from redrive).
        //
        // The guard excludes ONLY 'ready' — never downgrade a file that already
        // succeeded. It must NOT exclude 'unrecognized': the INSERT above just
        // set this row to 'unrecognized', so an `... NOT IN ('unrecognized')`
        // guard would skip the freshly-inserted row and leave next_retry_at NULL
        // forever → redrive never re-ingests it → a recognised-once-profiles-fixed
        // file (or one that simply lost the dual-view race) stays invisible. Each
        // redrive re-run recomputes the CASE from uploaded_at, so the interval
        // only widens with age — no tight loop.
        await tx.execute(sql`
          UPDATE file_metadata
             SET processing_state = 'unrecognized',
                 next_retry_at = CASE
                   WHEN uploaded_at > NOW() - INTERVAL '1 hour'  THEN NOW() + INTERVAL '5 minutes'
                   WHEN uploaded_at > NOW() - INTERVAL '6 hours' THEN NOW() + INTERVAL '30 minutes'
                   WHEN uploaded_at > NOW() - INTERVAL '1 day'   THEN NOW() + INTERVAL '2 hours'
                   WHEN uploaded_at > NOW() - INTERVAL '7 days'  THEN NOW() + INTERVAL '6 hours'
                   ELSE NULL
                 END
           WHERE s3_bucket = ${s3Bucket} AND s3_key = ${s3Key}
             AND processing_state <> 'ready'
        `);
      } else {
        await tx.execute(sql`
          UPDATE file_metadata
             SET processing_state = ${terminalState}, next_retry_at = NULL
           WHERE s3_bucket = ${s3Bucket} AND s3_key = ${s3Key}
             AND processing_state NOT IN ('ready', ${terminalState})
        `);
      }
      return { created, state: terminalState };
    }
    const ev = parsedEvent!;
    const view = ev.views[0]; // single-file parse → exactly one view

    // 2. Serialize merge decisions per (user, camera) across all replicas.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${INGEST_LOCK_KEY1}, hashtext(${`${userId}:${ev.camera}`}))`,
    );

    // 3. Find a dual-view merge partner: same camera, view set disjoint with
    //    ours, within the match window. Candidates limited to a sargable ISO
    //    text range so idx_events_owner_camera stays usable without per-row
    //    EXTRACT (Fix C). Window: a partner EVENT can start up to (its duration
    //    + 5s) BEFORE this file (dualViewRecordingsMatch rule 2) — cover
    //    segments up to 1h. After this file, rules 2-3 cap the gap at ≤30s;
    //    120s is generous. Lexicographic compare on the ISO text works because
    //    events.timestamp is always ISO-8601 Zulu text.
    const fileMs = new Date(ev.timestamp).getTime();
    const PARTNER_LOOKBACK_MS = (3600 + 5) * 1000;
    const PARTNER_LOOKAHEAD_MS = 120 * 1000;
    const loIso = new Date(fileMs - PARTNER_LOOKBACK_MS).toISOString();
    const hiIso = new Date(fileMs + PARTNER_LOOKAHEAD_MS).toISOString();

    const candidates = await tx.execute<{
      id: string;
      timestamp: string;
      duration: number | null;
      view_ids: string[];
      date: string;
    }>(sql`
      SELECT e.id, e.timestamp, e.duration, e.date,
             COALESCE(array_agg(elf.view_id) FILTER (WHERE elf.view_id IS NOT NULL), '{}') AS view_ids
        FROM events e
        LEFT JOIN event_view_files elf ON elf.event_id = e.id
       WHERE e.owner_id = ${userId}
         AND e.camera = ${ev.camera}
         AND e.timestamp >= ${loIso} AND e.timestamp <= ${hiIso}
       GROUP BY e.id
    `);

    let partner: { id: string; timestamp: string; duration: number | null } | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const c of candidates.rows) {
      if (c.view_ids.includes(view.id)) continue; // not disjoint (incl. exact same event id)
      const cMs = new Date(c.timestamp).getTime();
      if (!dualViewRecordingsMatch(cMs, c.duration ?? undefined, fileMs, undefined)) continue;
      const diff = Math.abs(cMs - fileMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        partner = c;
      }
    }

    const attachCtx = { ownerId: userId, s3Bucket, s3Key, ev, view, created, userUuid, userPrefix, profiles, rehomed };

    // 4a. No partner → upsert our own event row + attach the view.
    if (!partner) {
      const ins = await tx.execute(sql`
        INSERT INTO events (id, camera, timestamp, date, owner_id)
        VALUES (${ev.id}, ${ev.camera}, ${ev.timestamp}, ${ev.date}, ${userId})
        ON CONFLICT (id) DO NOTHING
      `);
      // rowCount is 0 when the row already existed (the second view of a
      // dual-view pair, or a redrive/audit replay) — so this counts recordings,
      // not files.
      recordEventsCreated('ingest', originFor(userUuid), ins.rowCount ?? 0);
      return attachView(tx, { eventId: ev.id, ...attachCtx });
    }

    // 4b. Partner exists and is earlier (or equal) → attach to the partner
    //     (keeper = earlier timestamp, same convention as the scanner merge).
    if (new Date(partner.timestamp).getTime() <= fileMs) {
      return attachView(tx, { eventId: partner.id, ...attachCtx });
    }

    // 4c. Partner exists but WE are earlier → keeper swap: create our event,
    //     move the partner's views onto it, delete the partner row (today's
    //     deleteDisplacedEvents parity; the orphaned generated thumbnail is
    //     cleaned by the audit job's storage pass).
    const keeperIns = await tx.execute(sql`
      INSERT INTO events (id, camera, timestamp, date, owner_id)
      VALUES (${ev.id}, ${ev.camera}, ${ev.timestamp}, ${ev.date}, ${userId})
      ON CONFLICT (id) DO NOTHING
    `);
    // The keeper replaces the partner one statement below, so this pairs with a
    // `merge` delete and nets to zero recordings — as it should, the user still
    // has exactly one event for this scene.
    recordEventsCreated('ingest', originFor(userUuid), keeperIns.rowCount ?? 0);
    await tx.execute(sql`
      UPDATE event_view_files SET event_id = ${ev.id}
       WHERE event_id = ${partner.id}
         AND NOT EXISTS (SELECT 1 FROM event_view_files x
                          WHERE x.event_id = ${ev.id} AND x.view_id = event_view_files.view_id)
    `);
    // Fix B: only delete the partner when it retains no elf rows; if a
    // conflicting view slot blocked the move the partner must survive.
    const partnerDelete = await tx.execute(sql`
      DELETE FROM events e
       WHERE e.id = ${partner.id} AND e.owner_id = ${userId}
         AND NOT EXISTS (SELECT 1 FROM event_view_files x WHERE x.event_id = e.id)
    `);
    recordEventsDeleted('merge', originFor(userUuid), partnerDelete.rowCount ?? 0);
    if ((partnerDelete.rowCount ?? 0) === 0) {
      // Heal (Sentry "keeper-swap left partner … alive"): the bulk move was
      // blocked because the keeper already holds the partner's view slot(s).
      // The partner is the chosen dual-view sibling (dualViewRecordingsMatch),
      // so its retained views are the legitimate views for this scene — the
      // merge was meant to fold them into the keeper. Resolve each surviving
      // collision with the SAME classify-occupant logic attachView uses
      // (incoming = partner's view, occupant = keeper's slot), then delete the
      // emptied partner. Leaves the partner alive only for the genuinely
      // unresolvable case (occupant unclassifiable AND partner's own path
      // unclassifiable) — there we keep the existing warn.
      await healDisplacedPartner(tx, {
        ownerId: userId,
        keeperId: ev.id,
        partnerId: partner.id,
        userUuid,
        userPrefix,
        profiles,
        camera: ev.camera,
        rehomed,
      });
    }
    return attachView(tx, { eventId: ev.id, ...attachCtx });
  });

  if ('duplicateNotice' in result && result.duplicateNotice) {
    try {
      await upsertDuplicateFileNotification(userId, result.duplicateNotice);
    } catch (err) {
      console.warn(
        'completeUpload: duplicate notification failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Strip the internal duplicateNotice field before returning to callers
  const { duplicateNotice: _dn, ...publicResult } = result as AttachResult;
  if ('eventId' in publicResult) {
    const extra = [...new Set(rehomed)].filter((id) => id !== publicResult.eventId);
    if (extra.length > 0) return { ...publicResult, rehomedEventIds: extra };
  }
  return publicResult as CompleteUploadResult;
}

// Insert the elf row; ON CONFLICT on the (event_id, view_id) PK means the
// slot is taken. Same path → idempotent no-op. Occupied by a different file →
// distinguish (a) TRUE duplicate (occupant maps to the same event id → same
// camera+date+tsRaw, different folder) → tombstone the upload + notify, from
// (b) MERGE ARTIFACT (occupant maps to a DIFFERENT event id → it was
// proximity-merge-absorbed into this event by an earlier upload; the incoming
// file is the legit canonical-tsRaw owner of the slot) → heal the slot to the
// incoming file and re-home the displaced occupant to its own standalone
// event, NO notification. Ports the old scanner's reconcileCrossScanSlots /
// healEventSlot semantics (e2e: duplicate-file dual-lens merge-artifact case).
//
// This collision branch is only reachable from branch 4a (eventId === ev.id),
// so the incoming file's tsRaw always equals the slot event's canonical tsRaw
// — that's why "occupant's own event id differs" cleanly means "artifact".
interface AttachArgs {
  eventId: string;
  ownerId: number;
  s3Bucket: string; // Fix A.2: needed for stale-terminal reconciliation
  s3Key: string; // the uploaded file's full key (tombstone target)
  ev: CameraEvent;
  view: CameraEvent['views'][number];
  created: boolean;
  userUuid: string;
  userPrefix: string;
  profiles: CameraProfile[];
  rehomed: string[]; // out: ids of events created for displaced views
}

/** Parse a single rel path back to its natural CameraEvent (id + fields), or
 *  null if it doesn't classify under the user's profiles. */
function parseEventOf(
  relPath: string,
  userUuid: string,
  userPrefix: string,
  profiles: CameraProfile[],
): CameraEvent | undefined {
  const parsed = parseS3Keys([{ key: userPrefix + relPath, size: 0 }], userPrefix, profiles);
  if (parsed.length === 0) return undefined;
  return buildEvents(userUuid, parsed).values().next().value;
}
type AttachResult = CompleteUploadResult & {
  duplicateNotice?: {
    eventId: string;
    camera: string;
    timestamp: string;
    viewId: string;
    visiblePath: string;
    hiddenPath: string;
  };
};

/**
 * Heal a keeper-swap (branch 4c) that left the partner alive because the
 * keeper already occupied the partner's view slot(s).
 *
 * Background — the bug this fixes (Sentry: "keeper-swap left partner <id>
 * alive (it retains a conflicting view slot)"): the keeper's id is derived
 * from the incoming wide's tsRaw. When that id already holds a view slot the
 * partner also holds, the bulk `UPDATE … SET event_id = keeper … NOT EXISTS`
 * could not move the partner's row, so the partner survived. The intended
 * dual-view merge silently failed and live Reolink cameras ended up with TWO
 * events for one scene (the keeper + an orphaned partner). Clean synthetic
 * uploads never seed a pre-existing conflicting slot, so only real cameras hit
 * it.
 *
 * Heal: the partner was *chosen* by dualViewRecordingsMatch as the legitimate
 * dual-view sibling, so each view it still holds is the legitimate view for
 * this scene. Resolve every surviving (keeper, view) collision with the SAME
 * classify-occupant logic attachView uses for an occupied slot:
 *
 *   - Keeper's occupant parses to a DIFFERENT natural event (foreign tsRaw =
 *     merge artifact): the occupant is debris. Re-home it to its own
 *     standalone event (so nothing is lost), then overwrite the keeper's slot
 *     with the partner's legitimate path. Partner view consumed.
 *   - Keeper's occupant parses to the keeper's OWN event (same tsRaw = a true
 *     second recording of that view) or is unclassifiable: the keeper's
 *     occupant wins (first-wins). Re-home the partner's displaced view to its
 *     own standalone event so it survives as its own single-view event.
 *   - Both occupant AND the partner's path unclassifiable: cannot safely
 *     resolve — leave that view on the partner and keep the historical warn.
 *
 * Finally delete the partner if it has been emptied. Runs inside the caller's
 * (user, camera) ingest advisory-locked transaction (no extra lock needed —
 * the keeper, partner, and any re-homed standalone all share that camera).
 */
async function healDisplacedPartner(
  tx: Tx,
  args: {
    ownerId: number;
    keeperId: string;
    partnerId: string;
    userUuid: string;
    userPrefix: string;
    profiles: CameraProfile[];
    camera: string;
    rehomed: string[];
  },
): Promise<void> {
  const { ownerId, keeperId, partnerId, userUuid, userPrefix, profiles, camera, rehomed } = args;

  const retained = await tx.execute<{ view_id: string; video_rel_path: string }>(sql`
    SELECT view_id, video_rel_path FROM event_view_files WHERE event_id = ${partnerId}
  `);

  let unresolvable = false;

  for (const { view_id: viewId, video_rel_path: partnerPath } of retained.rows) {
    // The keeper's current occupant of this slot.
    const occ = await tx.execute<{ video_rel_path: string }>(sql`
      SELECT video_rel_path FROM event_view_files
       WHERE event_id = ${keeperId} AND view_id = ${viewId}
    `);
    const occupantPath = occ.rows[0]?.video_rel_path;
    if (occupantPath === undefined) {
      // No collision after all (a concurrent run moved/cleared it): just move
      // the partner's view onto the keeper.
      await tx.execute(sql`
        UPDATE event_view_files SET event_id = ${keeperId}
         WHERE event_id = ${partnerId} AND view_id = ${viewId}
      `);
      continue;
    }
    if (occupantPath === partnerPath) {
      // Identical path already on the keeper → the partner's row is redundant.
      await tx.execute(sql`
        DELETE FROM event_view_files WHERE event_id = ${partnerId} AND view_id = ${viewId}
      `);
      continue;
    }

    const occupantEvent = parseEventOf(occupantPath, userUuid, userPrefix, profiles);

    if (occupantEvent && occupantEvent.id !== keeperId) {
      // MERGE ARTIFACT in the keeper's slot — the partner's view is the
      // canonical sibling. Re-home the foreign occupant to its own standalone
      // event, then overwrite the keeper's slot with the partner's path and
      // drop the (now-duplicated) partner row.
      const occView = occupantEvent.views[0];
      const rehomedIns = await tx.execute(sql`
        INSERT INTO events (id, camera, timestamp, date, owner_id)
        VALUES (${occupantEvent.id}, ${occupantEvent.camera}, ${occupantEvent.timestamp}, ${occupantEvent.date}, ${ownerId})
        ON CONFLICT (id) DO NOTHING
      `);
      recordEventsCreated('merge_heal', originFor(userUuid), rehomedIns.rowCount ?? 0);
      rehomed.push(occupantEvent.id);
      await tx.execute(sql`
        INSERT INTO event_view_files (event_id, view_id, video_rel_path)
        VALUES (${occupantEvent.id}, ${occView.id}, ${occView.videoRelPath})
        ON CONFLICT (event_id, view_id) DO NOTHING
      `);
      await tx.execute(sql`
        UPDATE event_view_files SET video_rel_path = ${partnerPath}
         WHERE event_id = ${keeperId} AND view_id = ${viewId}
      `);
      await tx.execute(sql`
        DELETE FROM event_view_files WHERE event_id = ${partnerId} AND view_id = ${viewId}
      `);
      continue;
    }

    // Keeper's occupant is its OWN canonical view (same tsRaw) or
    // unclassifiable → first-wins: keep the keeper's occupant. Re-home the
    // partner's displaced view to its own standalone event so it survives.
    const partnerEvent = parseEventOf(partnerPath, userUuid, userPrefix, profiles);
    if (!partnerEvent) {
      // Cannot classify the partner's path AND the keeper's occupant didn't
      // resolve to a re-homeable artifact → genuinely unresolvable. Leave the
      // view on the partner (historical behavior) and keep the warn below.
      unresolvable = true;
      continue;
    }
    const pView = partnerEvent.views[0];
    const partnerStandalone = await tx.execute(sql`
      INSERT INTO events (id, camera, timestamp, date, owner_id)
      VALUES (${partnerEvent.id}, ${partnerEvent.camera}, ${partnerEvent.timestamp}, ${partnerEvent.date}, ${ownerId})
      ON CONFLICT (id) DO NOTHING
    `);
    recordEventsCreated('merge_heal', originFor(userUuid), partnerStandalone.rowCount ?? 0);
    if (partnerEvent.id === partnerId) {
      // The partner's view already lives on its own natural event (the
      // partner) — it cannot be folded into the keeper. Nothing to move; the
      // partner legitimately survives as its own single-view event.
      continue;
    }
    // Partner's view belongs to a third standalone event: move it there.
    rehomed.push(partnerEvent.id);
    await tx.execute(sql`
      INSERT INTO event_view_files (event_id, view_id, video_rel_path)
      VALUES (${partnerEvent.id}, ${pView.id}, ${pView.videoRelPath})
      ON CONFLICT (event_id, view_id) DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM event_view_files WHERE event_id = ${partnerId} AND view_id = ${viewId}
    `);
  }

  // Delete the partner if the heal emptied it.
  const del = await tx.execute(sql`
    DELETE FROM events e
     WHERE e.id = ${partnerId} AND e.owner_id = ${ownerId}
       AND NOT EXISTS (SELECT 1 FROM event_view_files x WHERE x.event_id = e.id)
  `);
  recordEventsDeleted('merge', originFor(userUuid), del.rowCount ?? 0);

  if ((del.rowCount ?? 0) === 0 && unresolvable) {
    console.warn(
      `completeUpload: keeper-swap left partner ${partnerId} alive (it retains an ` +
      `unclassifiable conflicting view slot) — owner=${ownerId} camera=${camera}`,
    );
  }
}

async function attachView(tx: Tx, args: AttachArgs): Promise<AttachResult> {
  const { eventId, ownerId, s3Bucket, s3Key, ev, view, created, userUuid, userPrefix, profiles, rehomed } = args;
  const ins = await tx.execute<{ event_id: string }>(sql`
    INSERT INTO event_view_files (event_id, view_id, video_rel_path)
    VALUES (${eventId}, ${view.id}, ${view.videoRelPath})
    ON CONFLICT (event_id, view_id) DO NOTHING
    RETURNING event_id
  `);
  if (ins.rows.length > 0) {
    // Fix A.2: link succeeded — clear any stale administrative tombstone so
    // the event's any_unplayable aggregate is not permanently set.
    // Genuine 'unplayable' (class D/E) and 'ready' rows are left untouched.
    await tx.execute(sql`
      UPDATE file_metadata
         SET processing_state = 'pending_sidecar',
             next_retry_at = NULL
       WHERE s3_bucket = ${s3Bucket} AND s3_key = ${s3Key}
         AND processing_state IN ('duplicate', 'unrecognized', 'not_applicable')
    `);
    return { created, state: 'pending_sidecar', eventId, ownerId };
  }
  const existing = await tx.execute<{ video_rel_path: string }>(sql`
    SELECT video_rel_path FROM event_view_files
     WHERE event_id = ${eventId} AND view_id = ${view.id}
  `);
  const occupiedBy = existing.rows[0]?.video_rel_path ?? '';
  if (occupiedBy === view.videoRelPath) {
    // Idempotent re-register of the already-linked file. Also clear any stale
    // tombstone for the same reason as the fresh-insert path above.
    await tx.execute(sql`
      UPDATE file_metadata
         SET processing_state = 'pending_sidecar',
             next_retry_at = NULL
       WHERE s3_bucket = ${s3Bucket} AND s3_key = ${s3Key}
         AND processing_state IN ('duplicate', 'unrecognized', 'not_applicable')
    `);
    return { created, state: 'pending_sidecar', eventId, ownerId };
  }
  // Slot held by a DIFFERENT file. Classify the occupant: does it naturally
  // belong to THIS event (same canonical tsRaw) or was it merge-absorbed?
  const occupantEvent = parseEventOf(occupiedBy, userUuid, userPrefix, profiles);

  if (occupantEvent && occupantEvent.id !== eventId) {
    // MERGE ARTIFACT: the occupant's natural event differs from this one — an
    // earlier proximity-merge pulled it into this slot. The incoming file is
    // the canonical-tsRaw owner. Heal the slot to the incoming file and
    // re-home the displaced occupant to its own standalone event. No
    // duplicate notification — both files end up linked.
    const occView = occupantEvent.views[0];
    const occRehomed = await tx.execute(sql`
      INSERT INTO events (id, camera, timestamp, date, owner_id)
      VALUES (${occupantEvent.id}, ${occupantEvent.camera}, ${occupantEvent.timestamp}, ${occupantEvent.date}, ${ownerId})
      ON CONFLICT (id) DO NOTHING
    `);
    recordEventsCreated('merge_heal', originFor(userUuid), occRehomed.rowCount ?? 0);
    rehomed.push(occupantEvent.id);
    await tx.execute(sql`
      INSERT INTO event_view_files (event_id, view_id, video_rel_path)
      VALUES (${occupantEvent.id}, ${occView.id}, ${occView.videoRelPath})
      ON CONFLICT (event_id, view_id) DO NOTHING
    `);
    // Heal: point this event's slot at the incoming (canonical) file.
    await tx.execute(sql`
      UPDATE event_view_files SET video_rel_path = ${view.videoRelPath}
       WHERE event_id = ${eventId} AND view_id = ${view.id}
    `);
    // Incoming is now linked → clear any stale tombstone (Fix A.2 parity).
    await tx.execute(sql`
      UPDATE file_metadata
         SET processing_state = 'pending_sidecar',
             next_retry_at = NULL
       WHERE s3_bucket = ${s3Bucket} AND s3_key = ${s3Key}
         AND processing_state IN ('duplicate', 'unrecognized', 'not_applicable')
    `);
    return { created, state: 'pending_sidecar', eventId, ownerId };
  }

  // TRUE duplicate: occupant maps to the same event (same camera+date+tsRaw,
  // different folder) — or is unclassifiable. First-wins: tombstone the upload.
  // Fix E.1: filter on (s3_bucket, s3_key) — the unique key — not (owner_id, s3_key).
  await tx.execute(sql`
    UPDATE file_metadata
       SET processing_state = 'duplicate', next_retry_at = NULL
     WHERE s3_bucket = ${s3Bucket} AND s3_key = ${s3Key}
  `);
  return {
    created,
    state: 'duplicate',
    eventId,
    ownerId,
    duplicateNotice: {
      eventId,
      camera: ev.camera,
      timestamp: ev.timestamp,
      viewId: view.id,
      visiblePath: occupiedBy,
      hiddenPath: view.videoRelPath,
    },
  };
}
