-- citext extension is required for case-insensitive text columns (email).
-- Drizzle-kit doesn't emit this automatically; it must precede the DDL.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE "email_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "email_tokens_kind_check" CHECK ("email_tokens"."kind" IN ('verify','reset','delete-account'))
);
--> statement-breakpoint
CREATE TABLE "passkey_backup_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text,
	"device_name" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"disk_space_bytes" bigint NOT NULL,
	"monthly_transfer_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" text NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"plan_id" integer,
	"encryption_salt" text,
	"disk_usage_bytes" bigint DEFAULT 0 NOT NULL,
	"transfer_usage_bytes" bigint DEFAULT 0 NOT NULL,
	"transfer_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"token_generation" integer DEFAULT 0 NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"lockout_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"auto_delete_oldest" boolean DEFAULT false NOT NULL,
	"accepted_terms_at" timestamp with time zone,
	"newsletter_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"auto_delete_after_days" integer,
	"storage_warn_email_sent_at" timestamp with time zone,
	"timezone" text DEFAULT 'Europe/Warsaw' NOT NULL,
	"upload_lifetime_bytes" bigint DEFAULT 0 NOT NULL,
	"deletion_status" text DEFAULT 'active' NOT NULL,
	"deletion_started_at" timestamp with time zone,
	"passkey_enabled" boolean DEFAULT false NOT NULL,
	"ftps_password_hash" text,
	"camera_profile_mode" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "users_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_camera_profile_mode_check" CHECK ("users"."camera_profile_mode" IN ('auto','reolink','hikvision','axis','foscam','custom'))
);
--> statement-breakpoint
CREATE TABLE "event_lens_files" (
	"event_id" text NOT NULL,
	"lens_id" text NOT NULL,
	"video_rel_path" text NOT NULL,
	"duration_ms" bigint,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_lens_files_event_id_lens_id_pk" PRIMARY KEY("event_id","lens_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"camera" text NOT NULL,
	"timestamp" text NOT NULL,
	"date" text NOT NULL,
	"thumbnail" text,
	"duration" real,
	"owner_id" integer,
	"thumbnail_attempts" integer DEFAULT 0 NOT NULL,
	"playback_ready" boolean DEFAULT false NOT NULL,
	"playback_unplayable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_metadata" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"playback_patch_ready_at" timestamp with time zone,
	"playback_patch_attempts" integer DEFAULT 0 NOT NULL,
	"playback_patch_unplayable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_camera_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"regex" text NOT NULL,
	"lens_default" text DEFAULT '00' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_camera_profiles_lens_default_check" CHECK (length("user_camera_profiles"."lens_default") BETWEEN 1 AND 16)
);
--> statement-breakpoint
CREATE TABLE "user_scan_state" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"last_scanned_at" timestamp with time zone NOT NULL,
	"last_seen_s3_key" text,
	"full_rescan_due_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	"scope" text NOT NULL,
	"family_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" "bytea" PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"family_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_txns" (
	"txn_id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"resource" text NOT NULL,
	"user_id" integer,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_txns_code_challenge_method_check" CHECK ("oauth_authorization_txns"."code_challenge_method" = 'S256')
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"software_id" text,
	"software_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	"scope" text NOT NULL,
	"family_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_to" "bytea",
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "storage_disk_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"email" text NOT NULL,
	"old_bytes" bigint NOT NULL,
	"new_bytes" bigint NOT NULL,
	"delta_bytes" bigint NOT NULL,
	"corrected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_orphan_objects" (
	"id" serial PRIMARY KEY NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" integer
);
--> statement-breakpoint
CREATE TABLE "storage_reconciliation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"users_checked" integer DEFAULT 0 NOT NULL,
	"corrections_made" integer DEFAULT 0 NOT NULL,
	"orphans_found" integer DEFAULT 0 NOT NULL,
	"orphan_bytes_total" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"zombies_cleaned" integer DEFAULT 0 NOT NULL,
	"zombies_remaining" integer DEFAULT 0 NOT NULL,
	"events_reconciled" integer DEFAULT 0 NOT NULL,
	"events_deleted" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_events_bytes_check" CHECK ("upload_events"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer,
	"client_id" uuid,
	"action" text NOT NULL,
	"details_json" jsonb NOT NULL,
	"ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_appeals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by" integer
);
--> statement-breakpoint
CREATE TABLE "user_bans" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"issued_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "user_bans_type_check" CHECK ("user_bans"."type" IN ('manual', 'lockout'))
);
--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_backup_codes" ADD CONSTRAINT "passkey_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_lens_files" ADD CONSTRAINT "event_lens_files_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_metadata" ADD CONSTRAINT "file_metadata_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_camera_profiles" ADD CONSTRAINT "user_camera_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scan_state" ADD CONSTRAINT "user_scan_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_txns" ADD CONSTRAINT "oauth_authorization_txns_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_txns" ADD CONSTRAINT "oauth_authorization_txns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_disk_corrections" ADD CONSTRAINT "storage_disk_corrections_run_id_storage_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."storage_reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_disk_corrections" ADD CONSTRAINT "storage_disk_corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_orphan_objects" ADD CONSTRAINT "storage_orphan_objects_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_events" ADD CONSTRAINT "upload_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_audit_log" ADD CONSTRAINT "mcp_audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_audit_log" ADD CONSTRAINT "mcp_audit_log_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_appeals" ADD CONSTRAINT "user_appeals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_email_tokens_user" ON "email_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_email_tokens_cleanup" ON "email_tokens" USING btree ("expires_at") WHERE "email_tokens"."used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_passkey_backup_codes_user" ON "passkey_backup_codes" USING btree ("user_id") WHERE "passkey_backup_codes"."used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_passkeys_user" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_users_deletion_status" ON "users" USING btree ("deletion_status") WHERE "users"."deletion_status" <> 'active';--> statement-breakpoint
CREATE INDEX "idx_event_lens_files_event" ON "event_lens_files" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_lens_files_path" ON "event_lens_files" USING btree ("video_rel_path");--> statement-breakpoint
CREATE INDEX "idx_events_timestamp" ON "events" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_events_camera" ON "events" USING btree ("camera");--> statement-breakpoint
CREATE INDEX "idx_events_owner" ON "events" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_events_owner_camera" ON "events" USING btree ("owner_id","camera");--> statement-breakpoint
CREATE UNIQUE INDEX "file_metadata_s3_bucket_s3_key_key" ON "file_metadata" USING btree ("s3_bucket","s3_key");--> statement-breakpoint
CREATE INDEX "idx_file_metadata_owner" ON "file_metadata" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_file_metadata_owner_uploaded" ON "file_metadata" USING btree ("owner_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "idx_file_metadata_owner_s3key" ON "file_metadata" USING btree ("owner_id","s3_key");--> statement-breakpoint
CREATE INDEX "idx_file_metadata_owner_patch_pending" ON "file_metadata" USING btree ("owner_id") WHERE "file_metadata"."playback_patch_ready_at" IS NULL AND "file_metadata"."playback_patch_unplayable" = FALSE;--> statement-breakpoint
CREATE INDEX "idx_user_camera_profiles_user_priority" ON "user_camera_profiles" USING btree ("user_id","priority");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_user" ON "oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_family" ON "oauth_access_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_expires" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_codes_expires" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_txns_created" ON "oauth_authorization_txns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_user" ON "oauth_clients" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_family" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_refresh_tokens_expires" ON "oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_disk_corrections_run" ON "storage_disk_corrections" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_disk_corrections_user" ON "storage_disk_corrections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_orphan_objects_s3_bucket_s3_key_key" ON "storage_orphan_objects" USING btree ("s3_bucket","s3_key");--> statement-breakpoint
CREATE INDEX "idx_orphans_acknowledged" ON "storage_orphan_objects" USING btree ("acknowledged");--> statement-breakpoint
CREATE INDEX "idx_upload_events_user_time" ON "upload_events" USING btree ("user_id","uploaded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_upload_events_uploaded_at" ON "upload_events" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX "idx_audit_user_ts" ON "mcp_audit_log" USING btree ("user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_action_ts" ON "mcp_audit_log" USING btree ("action","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_user_appeals_email" ON "user_appeals" USING btree ("user_email","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_bans_active" ON "user_bans" USING btree ("user_id","expires_at") WHERE "user_bans"."cancelled_at" IS NULL;--> statement-breakpoint
-- Seed default plans on a fresh database. Idempotent via ON CONFLICT so
-- the statement is safe on already-seeded DBs (e.g. local dev / repeat
-- migrate runs). Matches the seed previously baked into the legacy
-- migrateBody() in server/db.ts pre-Drizzle.
--
-- 'Tiny' is intentionally undersized (128 KiB disk / 256 KiB transfer)
-- so the backend E2E quota tests can exhaust it in seconds with 64 KiB
-- fixtures. Only the admin plan list surfaces it (plans endpoint is
-- admin-only), so real users never see it during registration.
INSERT INTO "plans" ("name", "disk_space_bytes", "monthly_transfer_bytes") VALUES
  ('Basic', 1073741824, 5368709120),
  ('Pro',   10737418240, 21474836480),
  ('Max',   5497558138880, 10995116277760),
  ('Tiny',  131072, 262144)
ON CONFLICT (name) DO NOTHING;
