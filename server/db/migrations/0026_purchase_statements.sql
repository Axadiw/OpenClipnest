-- Purchase statements and the deletion-schedule columns of the new terms.
-- purchase_statements keeps every statement a user made when buying a
-- plan or moving to a higher one (version, language, the exact text shown,
-- the terms version, the time) — the proof that performance started at the
-- consumer's request.
-- content_deletions gains the notice-cycle reference (a new first notice
-- after the 30-day bound was missed or after an undeliverable hold), the date
-- the first notice stated, and the reason / end of a hold. account_notices
-- gains the e-mail provider's message id (bounces are matched by it).
-- Additive only.
CREATE TABLE IF NOT EXISTS "purchase_statements" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "version" text NOT NULL,
  "language" text NOT NULL,
  "statement_text" text NOT NULL,
  "terms_version" text NOT NULL,
  "plan_name" text NOT NULL,
  "price_lookup_key" text NOT NULL,
  "from_price_lookup_key" text,
  "request_id" text,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmation_invoice_id" text,
  "confirmation_claimed_at" timestamp with time zone,
  "confirmation_sent_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_statements_user_idx" ON "purchase_statements" ("user_id", "accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_statements_request_uq" ON "purchase_statements" ("user_id", "request_id") WHERE "request_id" IS NOT NULL;--> statement-breakpoint
-- One paid invoice confirms one statement.
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_statements_confirmation_invoice_uq" ON "purchase_statements" ("confirmation_invoice_id") WHERE "confirmation_invoice_id" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "purchase_statements" ADD CONSTRAINT "purchase_statements_kind_check" CHECK ("kind" IN ('purchase', 'upgrade'));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "purchase_statements" ADD CONSTRAINT "purchase_statements_language_check" CHECK ("language" IN ('pl', 'en'));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "content_deletions" ADD COLUMN IF NOT EXISTS "notice_ref_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_deletions" ADD COLUMN IF NOT EXISTS "first_stated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_deletions" ADD COLUMN IF NOT EXISTS "hold_reason" text;--> statement-breakpoint
ALTER TABLE "content_deletions" ADD COLUMN IF NOT EXISTS "hold_expires_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "content_deletions" ADD CONSTRAINT "content_deletions_hold_reason_check" CHECK ("hold_reason" IS NULL OR "hold_reason" IN ('admin', 'undeliverable'));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
-- Holds taken before this migration are administrator holds; they get the
-- 90-day bound from the moment they were taken. 2160 hours (90 x 24 h) is an
-- absolute span like HOLD_MAX_MS: '90 days' would follow the session time
-- zone across a DST change and land an hour off.
UPDATE "content_deletions" SET "hold_reason" = 'admin', "hold_expires_at" = "held_at" + interval '2160 hours'
 WHERE "held_at" IS NOT NULL AND "hold_reason" IS NULL;--> statement-breakpoint
-- The date a first notice stated is the schedule's date at the time.
UPDATE "content_deletions" SET "first_stated_at" = "delete_after" WHERE "first_stated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "account_notices" ADD COLUMN IF NOT EXISTS "provider_message_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_notices_message_idx" ON "account_notices" ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "content_deletion_runs" ADD COLUMN IF NOT EXISTS "renotices" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_deletion_runs" ADD COLUMN IF NOT EXISTS "holds_released" integer DEFAULT 0 NOT NULL;
