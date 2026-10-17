-- Preview-phase invite codes. An admin mints a batch for a given plan; the
-- holder redeems one during registration and skips the manual activation
-- queue, receiving that plan. Email verification still applies — see
-- server/db/schema/invites.ts for why the code alone must not activate.
--
-- Codes never expire. `revoked_at` is the admin's off-switch and is only
-- permitted while `used_at IS NULL`, so the `used_by` link is permanent once
-- a code has been spent.
CREATE TABLE "invite_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"plan_id" integer NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" integer,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invite_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invite_codes_used_by" ON "invite_codes" USING btree ("used_by") WHERE "invite_codes"."used_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_invite_codes_available" ON "invite_codes" USING btree ("plan_id") WHERE "invite_codes"."used_at" IS NULL AND "invite_codes"."revoked_at" IS NULL;
