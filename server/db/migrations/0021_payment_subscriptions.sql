-- Payment provider state for paid plans. A customer row links an account to
-- its customer at the provider; a subscriptions row mirrors one subscription
-- as the provider last reported it; payment_events makes webhook handling
-- idempotent. users.plan_source says where the current plan came from
-- (granted by an admin, by an invite code, or bought), plan_expires_at when a
-- granted plan runs out (NULL = no end).
CREATE TABLE IF NOT EXISTS "payment_customers" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_customers_provider_customer_id_unique" UNIQUE("provider_customer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"price_lookup_key" text,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"waiver_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_customers" ADD CONSTRAINT "payment_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx" ON "subscriptions" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_source" text DEFAULT 'admin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_plan_source_check";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_source_check" CHECK ("plan_source" IN ('admin', 'invite', 'subscription'));
--> statement-breakpoint
UPDATE "users" u SET "plan_source" = 'invite'
  WHERE "plan_source" = 'admin' AND EXISTS (SELECT 1 FROM "invite_codes" ic WHERE ic."used_by" = u."id");
