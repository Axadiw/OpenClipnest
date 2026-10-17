ALTER TABLE "user_bans" ADD COLUMN "source_ip" "inet";--> statement-breakpoint
CREATE TABLE "ip_login_attempts" (
	"source_ip" "inet" PRIMARY KEY NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lockout_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_user_bans_ip_active" ON "user_bans" USING btree ("source_ip","expires_at") WHERE "user_bans"."cancelled_at" IS NULL;
