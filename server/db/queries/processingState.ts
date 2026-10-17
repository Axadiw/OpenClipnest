// Queries for the explicit per-file processing state machine (spec §1, §7).
import { sql } from 'drizzle-orm';
import { db } from '../index.js';

/**
 * Linked, due, non-terminal files → (eventId, ownerId) to re-publish.
 * The redrive CronJob is the ONLY minute-cadence safety net in the new
 * model: it re-drives bounded retries for rows whose thumbnail-stream job
 * was lost. Unlinked rows (no elf) are healed by the audit job instead.
 */
export async function getSidecarRedriveBatch(
  limit = 500,
): Promise<{ eventId: string; ownerId: number }[]> {
  const result = await db.execute<{ eventId: string; ownerId: number }>(sql`
    SELECT DISTINCT e.id AS "eventId", e.owner_id AS "ownerId"
      FROM file_metadata fm
      JOIN users u ON u.id = fm.owner_id
      JOIN event_view_files elf
        ON elf.video_rel_path = SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2)
      JOIN events e ON e.id = elf.event_id AND e.owner_id = fm.owner_id
     WHERE fm.processing_state = 'pending_sidecar'
       AND (fm.next_retry_at IS NULL OR fm.next_retry_at < NOW())
     LIMIT ${limit}
  `);
  return result.rows;
}
