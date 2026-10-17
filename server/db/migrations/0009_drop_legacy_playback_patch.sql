-- 0009: drop legacy playback_patch_* columns now that all readers/writers
-- use processing_state (added in 0008). Adds processing_attempts as the
-- clean replacement for the retry-budget counter (was playback_patch_attempts).
-- Safe: no live code reads these columns after R3-T5 phase-1 rewrite.

ALTER TABLE file_metadata
  DROP COLUMN IF EXISTS playback_patch_ready_at,
  DROP COLUMN IF EXISTS playback_patch_unplayable,
  DROP COLUMN IF EXISTS playback_patch_attempts;--> statement-breakpoint

ALTER TABLE file_metadata
  ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint

-- The legacy partial index guarded by playback_patch_ready_at IS NULL AND
-- playback_patch_unplayable = FALSE is superseded by
-- idx_file_metadata_owner_state_pending (added in 0008). Drop it now that
-- the columns are gone.
DROP INDEX IF EXISTS idx_file_metadata_owner_patch_pending;
