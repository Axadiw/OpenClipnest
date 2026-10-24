-- Deleting the recordings of an account whose access ended for lack of an
-- active plan, and the ledgers around it. content_deletions holds one lock
-- episode per account: when the recordings may go (delete_after), an
-- administrator's hold, the point of no return (started_at — only content
-- older than it is deleted) and the end. account_notices records each notice
-- sent, once per (account, kind, reference time). content_deletion_runs is
-- one row per run of the daily job; a row without finished_at was killed.
-- Additive only.
CREATE TABLE IF NOT EXISTS "content_deletions" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "lock_started_at" timestamp with time zone NOT NULL,
  "delete_after" timestamp with time zone NOT NULL,
  "held_at" timestamp with time zone,
  "held_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "hold_note" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "objects_removed" integer DEFAULT 0 NOT NULL,
  "rows_removed" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_deletion_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "mode" text NOT NULL,
  "candidates" integer DEFAULT 0 NOT NULL,
  "first_notices" integer DEFAULT 0 NOT NULL,
  "final_notices" integer DEFAULT 0 NOT NULL,
  "due" integer DEFAULT 0 NOT NULL,
  "deleted" integer DEFAULT 0 NOT NULL,
  "resumed" integer DEFAULT 0 NOT NULL,
  "held" integer DEFAULT 0 NOT NULL,
  "skipped" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "deferred" integer DEFAULT 0 NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_notices" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "ref_at" timestamp with time zone NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_notices_pkey" PRIMARY KEY ("user_id", "kind", "ref_at")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "account_notices" ADD CONSTRAINT "account_notices_kind_check"
    CHECK ("account_notices"."kind" IN ('content_deletion_first', 'content_deletion_final', 'content_deleted'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
