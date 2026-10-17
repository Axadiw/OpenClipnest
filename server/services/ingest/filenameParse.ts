/**
 * Filename-parsing helpers shared by the synchronous ingest path (completeUpload.ts),
 * the delete-notify handler, and eventBuilder.ts.
 *
 * These were previously part of services/scanner.ts. Extracted here in R3 so
 * the scanner can be deleted without stranding its live callers.
 */

import { classifyFilename, type ClassifiedFile, type CameraProfile } from '../../config/cameraProfiles.js';
import { VIDEO_EXTS } from '../scannerExts.js';
import { GLOBAL_CAMERA_PROFILES } from '../cameraProfileResolver.js';
import type { ParsedFile } from '../scanner/eventBuilder.js';

export { VIDEO_EXTS, GLOBAL_CAMERA_PROFILES };
export const VIDEO_EXT_SET: ReadonlySet<string> = new Set(VIDEO_EXTS);

export function classifyBasename(basename: string): ClassifiedFile | null {
  return classifyFilename(basename, GLOBAL_CAMERA_PROFILES);
}

export interface ParsedDeleteKey {
  userUuid: string;
  eventId: string;      // base64url event ID — same derivation as buildEvents()
  dateStr: string;      // "YYYY/MM/DD" — for targeted S3 LIST prefix
  camera: string;       // camera name (without view suffix)
  tsRaw: string;        // 14-digit timestamp string
}

/**
 * Parse an S3 recordings-bucket key into the coordinates needed to locate the
 * event in DB and list remaining sibling files after a deletion.
 *
 * Returns null if the key doesn't match the expected format. Pure function — no I/O.
 *
 * S3 key formats accepted:
 *   - `{user_uuid}/YYYY/MM/DD/CameraName_View_Timestamp.{ext}`  (canonical)
 *   - `{user_uuid}/CameraName_View_Timestamp.{ext}`             (root-dir upload)
 *
 * The canonical `dateStr` comes from the filename's 14-digit timestamp, not
 * the folder path. That keeps event IDs stable when a camera writes into a
 * wrong-dated folder and matches the scanner's own parseS3Keys logic.
 */
export function parseS3KeyForDelete(s3Key: string): ParsedDeleteKey | null {
  if (!s3Key) return null;

  const slashIdx = s3Key.indexOf('/');
  if (slashIdx === -1) return null;

  const userUuid = s3Key.slice(0, slashIdx);
  const rest = s3Key.slice(slashIdx + 1);
  if (!rest) return null;

  const filename = rest.split('/').pop() ?? '';
  const classified = classifyBasename(filename);
  if (!classified) return null;

  const { camera, tsRaw } = classified;
  const yyyy = tsRaw.slice(0, 4);
  const mm = tsRaw.slice(4, 6);
  const dd = tsRaw.slice(6, 8);
  const dateStr = `${yyyy}/${mm}/${dd}`;
  // Same hash as buildEvents() — user UUID is part of the identity so two
  // users with identical source files map to different eventIds.
  const eventId = Buffer.from(`${userUuid}/${dateStr}/${camera}_${tsRaw}`).toString('base64url');

  return { userUuid, eventId, dateStr, camera, tsRaw };
}

export function parseTimestampEpoch(ts: string): number {
  return new Date(
    parseInt(ts.slice(0, 4)), parseInt(ts.slice(4, 6)) - 1, parseInt(ts.slice(6, 8)),
    parseInt(ts.slice(8, 10)), parseInt(ts.slice(10, 12)), parseInt(ts.slice(12, 14)),
  ).getTime() / 1000;
}

/**
 * Pull the 14-digit tsRaw out of a stored S3 relative path. Strips any
 * directory prefix (the path may be `YYYY/MM/DD/...mp4`, `backup/...mp4`,
 * or a legacy bare basename) and runs the same classifier the scanner
 * uses for fresh S3 listings.
 *
 * Returns `null` when no active camera profile matches the basename —
 * `reconcileCrossScanSlots` treats that as "fall back to true-duplicate
 * behavior" because we can't tell whether the slot holds a merge
 * artifact or a legitimate same-tsRaw duplicate without parsing the
 * filename.
 *
 * Exported for `reconcileCrossScanSlots` and unit tests.
 */
export function extractTsRawFromRelPath(
  relPath: string,
  profiles: CameraProfile[],
): string | null {
  const parts = relPath.split('/');
  const basename = parts[parts.length - 1];
  const classified = classifyFilename(basename, profiles);
  return classified ? classified.tsRaw : null;
}

// Filename-classification LRU cache — see scanner.ts for the full rationale.
const CLASSIFY_CACHE_CAP = 50_000;
const classifyCache = new Map<string, ClassifiedFile | null>();

function classifyFilenameCached(
  filename: string,
  profiles: CameraProfile[],
  profileSig: string,
): ClassifiedFile | null {
  const key = `${profileSig}:${filename}`;
  if (classifyCache.has(key)) {
    const v = classifyCache.get(key) ?? null;
    classifyCache.delete(key);
    classifyCache.set(key, v);
    return v;
  }
  const v = classifyFilename(filename, profiles);
  if (classifyCache.size >= CLASSIFY_CACHE_CAP) {
    const oldest = classifyCache.keys().next().value;
    if (oldest !== undefined) classifyCache.delete(oldest);
  }
  classifyCache.set(key, v);
  return v;
}

function profilesSignature(profiles: CameraProfile[]): string {
  return profiles.map(p => p.name).join('|');
}

/**
 * Walk the S3 LIST result and return only the video files that belong to
 * the user's event stream. Image sidecars (jpg/png/…) that a camera may
 * upload alongside are ignored here — the scanner doesn't use them, and
 * the thumbnail-worker produces the normalized thumbnail via ffmpeg.
 *
 * Each returned `ParsedFile` carries the relative path from the user's
 * prefix root plus the camera/view/timestamp fields that buildEvents()
 * keys the event map on.
 */
export function parseS3Keys(
  objects: { key: string; size: number }[],
  userPrefix: string,
  profiles: CameraProfile[] = GLOBAL_CAMERA_PROFILES,
): ParsedFile[] {
  const mp4Files: ParsedFile[] = [];
  const profileSig = profilesSignature(profiles);

  for (const obj of objects) {
    const relKey = obj.key.slice(userPrefix.length);
    if (!relKey || relKey.endsWith('/')) continue; // skip directory markers

    const parts = relKey.split('/');
    const filename = parts[parts.length - 1];
    const classified = classifyFilenameCached(filename, profiles, profileSig);
    if (!classified) continue;
    if (!VIDEO_EXT_SET.has(classified.ext)) continue;

    // Derive the canonical YYYY/MM/DD date string from the filename's
    // embedded timestamp. This is the source of truth, regardless of what
    // the folder path says — cameras with wrong clocks write into future
    // folders, and desktop clients sometimes drop the file straight into
    // the user's root. Either way the event's date comes from the
    // 14-digit timestamp in the filename, not the path.
    const yyyy = classified.tsRaw.slice(0, 4);
    const mm = classified.tsRaw.slice(4, 6);
    const dd = classified.tsRaw.slice(6, 8);
    const dateStr = `${yyyy}/${mm}/${dd}`;

    mp4Files.push({
      camera: classified.camera,
      view: classified.view,
      timestamp: parseTimestampEpoch(classified.tsRaw),
      tsRaw: classified.tsRaw,
      ext: classified.ext,
      relPath: relKey,
      dateStr,
    });
  }

  return mp4Files;
}
