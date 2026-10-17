import { CONFIG } from '../config.js';
import { listMultipartUploads, abortMultipartUpload } from './s3.js';

// Abort incomplete multipart uploads older than this. A legitimate FTPS STOR
// completes in seconds-to-minutes, so a day-long floor never touches an
// in-flight upload while still bounding accumulation. Env-tunable
// (CLIPNEST_MPU_ABORT_AGE_HOURS) for the stress-test re-check.
const DEFAULT_AGE_HOURS = 24;

/**
 * Sweep every bucket for incomplete/aborted multipart uploads and abort the
 * stale ones. These are invisible to ListObjectsV2 but still bill storage
 * (16.63 GB / 699 uploads found on one deployment), and an object
 * Storage has no lifecycle rule to auto-expire them — so without this sweep
 * they accumulate forever from interrupted FTPS STORs. Best-effort: a list or
 * abort error is logged and never thrown, so it can't fail the audit CronJob.
 *
 * @param nowMs injectable clock (defaults to Date.now()) for deterministic tests
 */
export async function abortStaleMultipartUploads(
  nowMs: number = Date.now(),
): Promise<{ aborted: number; failed: number }> {
  const ageMs = (Number(process.env.CLIPNEST_MPU_ABORT_AGE_HOURS) || DEFAULT_AGE_HOURS) * 3600_000;
  let aborted = 0;
  let failed = 0;

  for (const bucket of [
    CONFIG.s3RecordingsBucket,
    CONFIG.s3ThumbnailsBucket,
    CONFIG.s3SidecarsBucket,
  ]) {
    let uploads: { key: string; uploadId: string; initiated?: Date }[];
    try {
      uploads = await listMultipartUploads(bucket);
    } catch (err) {
      console.error(
        `MPU sweep: list failed for bucket "${bucket}":`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const u of uploads) {
      const age = u.initiated ? nowMs - u.initiated.getTime() : Infinity;
      if (age < ageMs) continue; // too fresh — could be an in-flight upload
      try {
        await abortMultipartUpload(bucket, u.key, u.uploadId);
        aborted++;
      } catch (err) {
        failed++;
        console.warn(
          `MPU sweep: abort failed for ${bucket}/${u.key} (${u.uploadId}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  if (aborted > 0 || failed > 0) {
    console.log(`MPU sweep: aborted ${aborted} stale multipart upload(s), ${failed} failure(s)`);
  }
  return { aborted, failed };
}
