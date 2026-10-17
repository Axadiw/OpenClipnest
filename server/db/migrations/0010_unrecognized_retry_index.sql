-- 0010: partial index for unrecognized-file retry backoff.
-- Allows the 1-minute redrive to find unrecognized rows due for retry
-- without a seqscan. Backfills existing rows so they are picked up
-- on the next redrive tick.

CREATE INDEX idx_file_metadata_unrecognized_retry
  ON file_metadata(next_retry_at)
  WHERE processing_state = 'unrecognized' AND next_retry_at IS NOT NULL;--> statement-breakpoint

UPDATE file_metadata
   SET next_retry_at = NOW()
 WHERE processing_state = 'unrecognized' AND next_retry_at IS NULL;
