-- Two account locks instead of one, an explicit plan override, the next
-- scheduled plan change of a subscription, and a ledger of reconciliation runs.
--
-- access_locked_at stays the lock the plan rules set and lift (no active plan);
-- admin_locked_at is set and lifted only by an administrator. An account is
-- locked when either is set. plan_override_at marks a plan an administrator
-- set on purpose: while it is set (and plan_expires_at has not passed) nothing
-- but an administrator changes the plan. Additive only.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "scheduled_price_lookup_key" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "scheduled_change_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_reconcile_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "checked" integer DEFAULT 0 NOT NULL,
  "drifted" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "overrides_expired" integer DEFAULT 0 NOT NULL,
  "downgrades_cancelled" integer DEFAULT 0 NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
-- Until now one column held both kinds of lock. A lock the plan rules set is
-- on an account with no live subscription whose plan either comes from a
-- subscription, or was granted by an administrator or an invite and its date
-- has passed (decideEntitlement's `ended`); every other lock was set by an
-- administrator. Those are COPIED into admin_locked_at; access_locked_at is
-- left as it is, so code that predates this column (pods still running during
-- a rollout) keeps refusing the account. An administrator's unlock later
-- clears both. The condition is PLAN_LOCK_STANDS_SQL in
-- server/cloud/billing/store.ts — keep the two in step.
UPDATE "users" u
   SET "admin_locked_at" = u."access_locked_at"
 WHERE u."access_locked_at" IS NOT NULL
   AND u."admin_locked_at" IS NULL
   AND NOT (
     NOT EXISTS (
       SELECT 1 FROM "subscriptions" s
        WHERE s."user_id" = u."id" AND s."status" IN ('active', 'trialing', 'past_due')
     )
     AND (
       u."plan_source" = 'subscription'
       OR (
         u."plan_source" IN ('admin', 'invite')
         AND u."plan_expires_at" IS NOT NULL
         AND u."plan_expires_at" <= NOW()
       )
     )
   );
