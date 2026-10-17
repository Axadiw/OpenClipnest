-- Add events.created_at (ingest timestamp). Two-step on purpose:
--   1. ADD COLUMN with NO default  → catalog-only, instant, existing rows = NULL
--      (honest: we don't know when pre-existing events were first ingested).
--   2. SET DEFAULT now()           → catalog-only, instant, future inserts only.
-- A single `ADD COLUMN ... DEFAULT now()` would stamp every existing row with
-- the migration instant (misleading), so we keep the steps separate.
ALTER TABLE "events" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "created_at" SET DEFAULT now();
