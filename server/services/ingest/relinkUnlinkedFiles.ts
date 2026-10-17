// Audit-path healer: video files in a non-terminal state with no
// event_view_files row (legacy orphans from the scan era, or rows whose
// ingest tx raced a deploy). Runs them through the SAME completeUpload
// logic — minus quota (already claimed at upload time).
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { completeUpload } from './completeUpload.js';
import { publishThumbnailUnique } from '../streamsClient.js';

export async function relinkUnlinkedFiles(limit = 500): Promise<number> {
  const orphans = await db.execute<{
    id: number; ownerId: number; uuid: string; s3Bucket: string;
    s3Key: string; originalFilename: string; fileSizeBytes: number;
  }>(sql`
    SELECT fm.id, fm.owner_id AS "ownerId", u.uuid,
           fm.s3_bucket AS "s3Bucket", fm.s3_key AS "s3Key",
           fm.original_filename AS "originalFilename", fm.file_size_bytes AS "fileSizeBytes"
      FROM file_metadata fm
      JOIN users u ON u.id = fm.owner_id
     WHERE (
       (fm.processing_state = 'pending_sidecar'
        AND NOT EXISTS (
          SELECT 1 FROM event_view_files elf
            JOIN events e ON e.id = elf.event_id
           WHERE e.owner_id = fm.owner_id
             AND elf.video_rel_path = SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2)
        ))
       OR
       (fm.processing_state = 'unrecognized'
        AND fm.next_retry_at IS NOT NULL
        AND fm.next_retry_at <= NOW())
     )
     ORDER BY fm.uploaded_at DESC
     LIMIT ${limit}
  `);

  let healed = 0;
  for (const o of orphans.rows) {
    try {
      const result = await completeUpload({
        userId: o.ownerId, userUuid: o.uuid, s3Bucket: o.s3Bucket,
        s3Key: o.s3Key, originalFilename: o.originalFilename,
        fileSizeBytes: Number(o.fileSizeBytes),
      });
      if ((result.state === 'pending_sidecar' || result.state === 'ready') && 'eventId' in result) {
        await publishThumbnailUnique(result.eventId, result.ownerId, { notify: false })
          .catch(() => { /* redrive heals a lost publish */ });
        healed += 1;
      }
      // still unrecognized: completeUpload wrote a new next_retry_at with
      // age-based backoff — will be retried again on the next due tick.
    } catch (err) {
      console.error(`audit: relink failed for fm=${o.id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  if (orphans.rows.length > 0) {
    console.log(`audit: relink — ${healed} healed of ${orphans.rows.length} unlinked`);
  }
  return healed;
}
