ALTER TABLE "users" ADD COLUMN "upload_30d_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill the rolling 30-day counter from existing upload_events so the column
-- is correct the moment this migration lands; new uploads (recordUpload) and the
-- reaper (purgeOldUploadEvents) keep it maintained thereafter. On a fresh DB this
-- updates zero rows. Idempotent: re-running recomputes the same value.
UPDATE "users" u SET "upload_30d_bytes" = COALESCE((
  SELECT SUM(ue."bytes") FROM "upload_events" ue
  WHERE ue."user_id" = u."id" AND ue."uploaded_at" >= NOW() - INTERVAL '30 days'
), 0);