/**
 * Resolve an event's stored path (`thumbnail` / `wideVideo` / `zoomVideo`) to
 * the concrete S3 bucket + key. Two cases:
 *
 *   1. Generated thumbnails — stored as `__s3_thumb__/{uuid}/{eventId}.jpg`,
 *      live in the thumbnails bucket under `{uuid}/__generated__/...`.
 *   2. Everything else — recordings + camera-uploaded JPGs — live in the
 *      recordings bucket directly under `{uuid}/{rel}`.
 *
 * Path-traversal and cross-user references are rejected (`null` return).
 */
import { CONFIG } from '../config.js';

export function resolveS3Path(
  userUuid: string,
  thumbnailOrVideoPath: string,
): { bucket: string; key: string } | null {
  if (thumbnailOrVideoPath.includes('..') || thumbnailOrVideoPath.includes('\0')) {
    console.warn('Rejected suspicious media path:', thumbnailOrVideoPath);
    return null;
  }

  if (thumbnailOrVideoPath.startsWith('__s3_thumb__/')) {
    const parts = thumbnailOrVideoPath.replace('__s3_thumb__/', '').split('/');
    if (parts.length !== 2) return null;
    if (parts[0] !== userUuid) return null;
    if (!/^[A-Za-z0-9_-]+\.jpg$/.test(parts[1])) return null;
    return {
      bucket: CONFIG.s3ThumbnailsBucket,
      key: `${userUuid}/__generated__/${parts[1]}`,
    };
  }

  return {
    bucket: CONFIG.s3RecordingsBucket,
    key: `${userUuid}/${thumbnailOrVideoPath}`,
  };
}
