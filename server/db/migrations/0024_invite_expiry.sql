-- Invite codes get a redemption deadline (expires_at: the code cannot be used
-- after it) and a plan length (plan_duration_days: the granted plan ends that
-- many days after the redemption). Codes created before this release keep
-- both NULL = no limit. payment_reconcile_runs counts the granted plans whose
-- date passed and that the daily run therefore locked. Additive only.
ALTER TABLE "invite_codes" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN IF NOT EXISTS "plan_duration_days" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_plan_duration_days_check" CHECK ("invite_codes"."plan_duration_days" > 0);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "payment_reconcile_runs" ADD COLUMN IF NOT EXISTS "grants_expired" integer DEFAULT 0 NOT NULL;
