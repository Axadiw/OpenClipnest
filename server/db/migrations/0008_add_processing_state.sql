-- 0007: explicit per-file processing state machine + visibility decoupled
-- from thumbnails. Spec: docs/superpowers/specs/2026-06-12-video-pipeline-redesign-design.md
ALTER TABLE file_metadata
  ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'pending_sidecar',
  ADD COLUMN next_retry_at TIMESTAMPTZ;--> statement-breakpoint

ALTER TABLE file_metadata
  ADD CONSTRAINT file_metadata_processing_state_check CHECK (
    processing_state IN
      ('pending_sidecar','ready','unplayable','duplicate','unrecognized','not_applicable')
  );--> statement-breakpoint

-- Backfill from the legacy columns in one pass (single seq scan instead of
-- three; unplayable wins over ready; non-video rows — jpg snapshots,
-- directory markers — were implicitly excluded by extension regexes in 4
-- query sites; make that explicit and terminal).
UPDATE file_metadata
   SET processing_state = CASE
         WHEN playback_patch_unplayable = TRUE THEN 'unplayable'
         WHEN playback_patch_ready_at IS NOT NULL THEN 'ready'
         WHEN s3_key LIKE '%/'
              OR lower(regexp_replace(s3_key, '.*\.', ''))
                 NOT IN ('mp4','m4v','mov','mkv','webm','avi','ts','3gp')
           THEN 'not_applicable'
         ELSE 'pending_sidecar'
       END
 WHERE playback_patch_unplayable = TRUE
    OR playback_patch_ready_at IS NOT NULL
    OR s3_key LIKE '%/'
    OR lower(regexp_replace(s3_key, '.*\.', ''))
       NOT IN ('mp4','m4v','mov','mkv','webm','avi','ts','3gp');--> statement-breakpoint

-- Banner: one indexed read per poll.
CREATE INDEX idx_file_metadata_owner_state_pending
  ON file_metadata (owner_id) WHERE processing_state = 'pending_sidecar';--> statement-breakpoint
-- Redrive: due rows by next_retry_at (NULL = due immediately, handled in query).
CREATE INDEX idx_file_metadata_redrive
  ON file_metadata (next_retry_at) WHERE processing_state = 'pending_sidecar';--> statement-breakpoint

-- One-time recompute of events visibility under the NEW rule (decision 6 in
-- the spec): playback_ready no longer requires a thumbnail. playback_unplayable
-- semantics unchanged ('__unplayable__' thumbnail OR any unplayable file).
WITH attached AS (
  SELECT e.id AS event_id,
         BOOL_AND(CASE WHEN fm.id IS NOT NULL
                       THEN fm.playback_patch_ready_at IS NOT NULL
                       ELSE FALSE END) AS all_files_ready,
         BOOL_OR(COALESCE(fm.playback_patch_unplayable, FALSE)) AS any_unplayable
    FROM events e
    JOIN users u ON u.id = e.owner_id
    JOIN event_view_files elf ON elf.event_id = e.id
    LEFT JOIN file_metadata fm
      ON fm.owner_id = e.owner_id
     AND SUBSTRING(fm.s3_key FROM LENGTH(u.uuid) + 2) = elf.video_rel_path
   GROUP BY e.id
)
UPDATE events e
   SET playback_ready = COALESCE(a.all_files_ready, FALSE),
       playback_unplayable = (e.thumbnail IS NOT DISTINCT FROM '__unplayable__')
                             OR COALESCE(a.any_unplayable, FALSE)
  FROM attached a
 WHERE a.event_id = e.id;
