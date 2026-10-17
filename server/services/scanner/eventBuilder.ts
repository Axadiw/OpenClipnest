import type { CameraEvent } from '../../types.js';
import type { CameraProfile } from '../../config/cameraProfiles.js';
import { parseS3Keys, extractTsRawFromRelPath } from '../ingest/filenameParse.js';

/** Fallback proximity window (seconds) used when neither recording has a
 *  known duration — covers camera clock skew + FTP upload-timing jitter
 *  that can push wide/zoom start-timestamps up to ~30 s apart even for a
 *  single dual-view recording. Smaller than the shortest common segment
 *  length (typically 30–120 s) so consecutive segments are not folded. */
const VIEW_MERGE_FALLBACK_WINDOW_S = 30;
/** Minimum fraction of the shorter recording that must overlap for the pair
 *  to be considered the same event. 0.25 = 25 % — generous enough for a
 *  slow-starting zoom stream, strict enough to avoid merging back-to-back
 *  scenes that happen to share the edge of a segment boundary. */
const VIEW_OVERLAP_MIN_FRACTION = 0.25;

/**
 * Returns true when two recordings should be considered the same dual-view
 * event (wide + zoom of the same scene).
 *
 * Strategy (in priority order):
 *  1. Both durations known   → require ≥25% overlap of the shorter segment.
 *  2. One duration known     → the unknown recording's start must fall within
 *     [knownStart−5s, knownStart+knownDuration+5s] (±5s clock-skew slack).
 *  3. Neither duration known → fall back to a 30s proximity window.
 */
export function dualViewRecordingsMatch(
  aStartMs: number, aDuration: number | undefined,
  bStartMs: number, bDuration: number | undefined,
): boolean {
  const aS = aStartMs / 1000;
  const bS = bStartMs / 1000;

  // Dual-view clock-skew tolerance — checked FIRST, independent of duration.
  // Two views of the same event can have start timestamps up to
  // VIEW_MERGE_FALLBACK_WINDOW_S apart (lens clock skew / staggered upload).
  // This MUST NOT depend on whether a duration is known, because that is a
  // race with the thumbnail worker: in R3 sync-ingest the worker can build
  // view 00's sidecar (which writes events.duration) BEFORE view 01 arrives,
  // shrinking rule 2's window to [start-5, start+duration+5] — only ~7s for a
  // 2s clip — so a 14s-skewed pair splits into two events. The removed scanner
  // used to re-merge them via the unknown-duration fallback; restore that
  // behaviour here so a known short duration can't override the skew window.
  if (Math.abs(bS - aS) <= VIEW_MERGE_FALLBACK_WINDOW_S) return true;

  if (aDuration != null && bDuration != null) {
    const overlapStart = Math.max(aS, bS);
    const overlapEnd   = Math.min(aS + aDuration, bS + bDuration);
    if (overlapEnd <= overlapStart) return false;
    return (overlapEnd - overlapStart) / Math.min(aDuration, bDuration) >= VIEW_OVERLAP_MIN_FRACTION;
  }

  if (aDuration != null) {
    return bS >= aS - 5 && bS <= aS + aDuration + 5;
  }

  if (bDuration != null) {
    return aS >= bS - 5 && aS <= bS + bDuration + 5;
  }

  return Math.abs(bS - aS) <= VIEW_MERGE_FALLBACK_WINDOW_S;
}

export interface ParsedFile {
  camera: string;
  view: string;
  timestamp: number;
  tsRaw: string;
  ext: string;
  relPath: string;
  dateStr: string;
}

/**
 * Turn a list of parsed video files into the user-visible event map.
 * Events are keyed by `base64url(userUuid/dateStr/camera_tsRaw)` so every
 * view upload that shares a (camera, timestamp) — wide+zoom for Reolink,
 * arbitrary N for other vendors — collapses into the same event record.
 * Including the user UUID in the hash means two users uploading the same
 * source files end up with **different** eventIds — no cross-user PK
 * collision in the events table.
 */
export function buildEvents(userUuid: string, mp4Files: ParsedFile[]): Map<string, CameraEvent> {
  const eventMap = new Map<string, CameraEvent>();

  for (const f of mp4Files) {
    const groupKey = `${userUuid}/${f.dateStr}/${f.camera}_${f.tsRaw}`;
    const id = Buffer.from(groupKey).toString('base64url');
    if (!eventMap.has(id)) {
      eventMap.set(id, {
        id, camera: f.camera, timestamp: new Date(f.timestamp * 1000).toISOString(),
        date: f.dateStr, views: [], thumbnail: null,
      });
    }
    const ev = eventMap.get(id)!;
    // First-wins on duplicates: when the same (camera, view, timestamp)
    // appears under two different S3 paths (user uploaded the same file
    // to two folders), we keep the first observed path. The losing path
    // stays in S3 + file_metadata and is surfaced to the user via a
    // duplicate_file notification.
    if (!ev.views.some(l => l.id === f.view)) {
      ev.views.push({ id: f.view, videoRelPath: f.relPath });
    }
  }

  // Stable ordering for downstream eq checks + serialisation.
  for (const ev of eventMap.values()) {
    ev.views.sort((a, b) => a.id.localeCompare(b.id));
  }

  return eventMap;
}

export type DuplicateFileInfo = {
  eventId: string;
  camera: string;
  timestamp: string;
  /** Profile-defined view id (e.g. '00', '01', 'A'). Notification renderer
   *  resolves the user-facing label via the profile registry. */
  viewId: string;
  visiblePath: string;
  hiddenPath: string;
};

export function findDuplicatesInParsedFiles(
  userUuid: string,
  mp4Files: ParsedFile[],
): DuplicateFileInfo[] {
  const groups = new Map<string, ParsedFile[]>();
  for (const f of mp4Files) {
    const key = `${f.camera}|${f.view}|${f.tsRaw}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(f);
  }

  const dups: DuplicateFileInfo[] = [];
  for (const files of groups.values()) {
    if (files.length < 2) continue;
    const [first, ...rest] = files;
    const groupKey = `${userUuid}/${first.dateStr}/${first.camera}_${first.tsRaw}`;
    const eventId = Buffer.from(groupKey).toString('base64url');
    const timestamp = new Date(first.timestamp * 1000).toISOString();
    for (const dup of rest) {
      dups.push({
        eventId,
        camera: first.camera,
        timestamp,
        viewId: first.view,
        visiblePath: first.relPath,
        hiddenPath: dup.relPath,
      });
    }
  }
  return dups;
}

/**
 * One row of the heal list returned by `reconcileCrossScanSlots`. The
 * caller (`scanSingleUser`) feeds each entry to `db.healEventSlot` AFTER
 * `upsertEventsDelta` runs, because the upsert's
 * `COALESCE(events.<slot>, EXCLUDED.<slot>)` silently rejects any
 * overwrite when the existing DB cell is non-null — which is exactly the
 * merge-artifact case we're trying to repair. `healEventSlot` bypasses
 * COALESCE with a direct `UPDATE`.
 */
export interface SlotHeal {
  eventId: string;
  /** Profile-defined view id whose attachment needs overwriting in DB. */
  viewId: string;
  newPath: string;
}

/**
 * Cross-scan slot reconciliation. Replaces the old inline cross-scan loop
 * with a unified pass that distinguishes three sub-cases of slot mismatch
 * between the DB snapshot and the freshly scanned event:
 *
 *  1. Same tsRaw, different folder → genuine cross-scan duplicate. Emit
 *     a `DuplicateFileInfo` and enforce first-wins by overwriting
 *     `ev[slot]` with `prev[slot]`. (Identical to the previous behavior.)
 *
 *  2. Different tsRaw → dual-view merge artifact. A prior scan's
 *     `mergeNearbyEventsSync` consolidated a wide+zoom pair with
 *     non-matching timestamps; the DB row now references a file whose
 *     tsRaw does not align with the event id. Do NOT emit a duplicate
 *     (it isn't one). Do NOT touch `existing` (the DB snapshot stays
 *     true). Surface the displaced (merge-attached) path as a
 *     synthesized `ParsedFile` appended to `parsedFiles` and a
 *     corresponding event slot in `eventMap`, so the file remains in the
 *     user's library as its own event. Push a `SlotHeal` so the caller
 *     can issue a direct DB `UPDATE` to overwrite the existing cell —
 *     `upsertEventsDelta`'s COALESCE would otherwise reject the heal.
 *
 *  3. Either path unclassifiable → fall back to sub-case (1)'s behavior
 *     plus a `console.warn`. We can't tell which sub-case it really is,
 *     so the safest default is the current first-wins + notification.
 *
 * Pure / synchronous / in-memory. Returns the duplicate notifications
 * and the slot-heal list. Does NOT touch the DB.
 */
export function reconcileCrossScanSlots(
  eventMap: Map<string, CameraEvent>,
  existing: Map<string, CameraEvent>,
  parsedFiles: ParsedFile[],
  userUuid: string,
  userPrefix: string,
  profiles: CameraProfile[],
): { dups: DuplicateFileInfo[]; heals: SlotHeal[] } {
  const dups: DuplicateFileInfo[] = [];
  const heals: SlotHeal[] = [];

  for (const ev of Array.from(eventMap.values())) {
    const prev = existing.get(ev.id);
    if (!prev) continue;

    // Walk every view id present in either snapshot.
    const viewIds = new Set<string>([
      ...prev.views.map(l => l.id),
      ...ev.views.map(l => l.id),
    ]);

    for (const viewId of viewIds) {
      const prevView = prev.views.find(l => l.id === viewId);
      const evView = ev.views.find(l => l.id === viewId);
      const prevPath = prevView?.videoRelPath ?? null;
      const evPath = evView?.videoRelPath ?? null;
      if (!prevPath || !evPath) continue;
      if (prevPath === evPath) continue;

      const prevTs = extractTsRawFromRelPath(prevPath, profiles);
      const evTs = extractTsRawFromRelPath(evPath, profiles);

      const isUnclassifiable = prevTs === null || evTs === null;
      if (isUnclassifiable) {
        console.warn(
          `reconcileCrossScanSlots: unclassifiable view path for user=${userUuid} ` +
          `event=${ev.id} viewId=${viewId} prev=${prevPath} ev=${evPath} — ` +
          `falling back to true-duplicate behavior`,
        );
      }

      if (isUnclassifiable || prevTs === evTs) {
        // True cross-scan duplicate (same tsRaw, different folder) — or
        // unclassifiable fallback. Emit the dup and enforce first-wins by
        // pulling the previous path back into the in-memory eventMap.
        dups.push({
          eventId: ev.id,
          camera: ev.camera,
          timestamp: ev.timestamp,
          viewId,
          visiblePath: prevPath,
          hiddenPath: evPath,
        });
        if (evView) evView.videoRelPath = prevPath;
        continue;
      }

      // Merge artifact (prevTs !== evTs). evView.videoRelPath is the
      // better match (its tsRaw aligns with ev.id). Leave it alone, do
      // not emit a duplicate, and surface the displaced file so it does
      // not vanish. Queue a direct heal — upsertEventsDelta's first-wins
      // would otherwise silently keep the existing (foreign-tsRaw) value.
      heals.push({ eventId: ev.id, viewId, newPath: evPath });

      const alreadyInScan = parsedFiles.some(f => f.relPath === prevPath);
      if (alreadyInScan) continue;

      const synthesized = parseS3Keys(
        [{ key: userPrefix + prevPath, size: 0 }],
        userPrefix,
        profiles,
      );
      if (synthesized.length === 0) continue;
      parsedFiles.push(...synthesized);

      const synthesizedMap = buildEvents(userUuid, synthesized);
      for (const [synthId, synthEv] of synthesizedMap.entries()) {
        const existingScanEv = eventMap.get(synthId);
        if (!existingScanEv) {
          eventMap.set(synthId, synthEv);
          continue;
        }
        // Fill missing view slots only — do not overwrite a freshly
        // scanned path. Any non-empty mismatch becomes a genuine
        // intra-scan duplicate that findDuplicatesInParsedFiles will
        // catch via the parsedFiles entry we just appended.
        for (const synthView of synthEv.views) {
          if (!existingScanEv.views.some(l => l.id === synthView.id)) {
            existingScanEv.views.push(synthView);
          }
        }
        existingScanEv.views.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
  }

  return { dups, heals };
}

export function mergeNearbyEventsSync(eventMap: Map<string, CameraEvent>): void {
  const byCamera = new Map<string, CameraEvent[]>();
  for (const ev of eventMap.values()) {
    if (!byCamera.has(ev.camera)) byCamera.set(ev.camera, []);
    byCamera.get(ev.camera)!.push(ev);
  }

  for (const events of byCamera.values()) {
    // Enumerate every candidate pair whose view sets are *disjoint* (no
    // view id overlap), then merge in ascending timestamp-difference
    // order (exact matches first). For 2-view cameras the disjoint
    // condition simplifies to wide-only + zoom-only as before; for N-view
    // it pairs any two events that together cover more views than
    // either alone, e.g. {wide} + {zoom, tele}. A chronological
    // adjacent-pair sweep would greedily fold a zoom into the previous
    // wide even when the next wide is a closer / exact-tsRaw match —
    // that bug left a recording sitting in
    // file_metadata with no event slot referencing it, so the
    // "Processing files" counter never drained.
    type Pair = { a: CameraEvent; b: CameraEvent; diffMs: number };
    const pairs: Pair[] = [];
    for (let i = 0; i < events.length; i++) {
      const a = events[i];
      if (a.views.length === 0) continue;
      const aViewIds = new Set(a.views.map(l => l.id));
      const aMs = new Date(a.timestamp).getTime();
      for (let j = i + 1; j < events.length; j++) {
        const b = events[j];
        if (b.views.length === 0) continue;
        let disjoint = true;
        for (const l of b.views) {
          if (aViewIds.has(l.id)) { disjoint = false; break; }
        }
        if (!disjoint) continue;
        const bMs = new Date(b.timestamp).getTime();
        if (!dualViewRecordingsMatch(aMs, a.duration, bMs, b.duration)) continue;
        pairs.push({ a, b, diffMs: Math.abs(aMs - bMs) });
      }
    }

    pairs.sort((p, q) => p.diffMs - q.diffMs);

    const consumed = new Set<string>();
    for (const { a, b } of pairs) {
      if (consumed.has(a.id) || consumed.has(b.id)) continue;

      // Keep the earlier-by-timestamp event so the surviving event id
      // matches the earliest tsRaw — same convention as the previous
      // chronological-sweep algorithm.
      const keeper = new Date(a.timestamp).getTime() <= new Date(b.timestamp).getTime() ? a : b;
      const victim = keeper === a ? b : a;

      // Union view sets — disjoint check above guarantees no collisions.
      for (const l of victim.views) keeper.views.push(l);
      keeper.views.sort((x, y) => x.id.localeCompare(y.id));

      eventMap.delete(victim.id);
      consumed.add(a.id);
      consumed.add(b.id);
    }
  }
}
