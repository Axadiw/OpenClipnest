-- Failed-login lockouts per login channel. The web sign-in keeps the existing
-- users.failed_login_attempts / users.lockout_count; camera FTP/FTPS logins get
-- their own pair, so a camera with a stale password can no longer lock the
-- owner out of the web, nor the other way round. user_bans.channel says which
-- login a lockout blocks; it stays NULL on manual bans (they block everything)
-- and on lockouts written before this migration, which keep blocking both
-- logins until they expire. Additive only: code that predates it keeps working.
--
-- New accounts default to UTC instead of a fixed European zone; existing
-- accounts keep the zone they have.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ftp_failed_login_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ftp_lockout_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_bans" ADD COLUMN IF NOT EXISTS "channel" text;--> statement-breakpoint
ALTER TABLE "user_bans" DROP CONSTRAINT IF EXISTS "user_bans_channel_check";--> statement-breakpoint
ALTER TABLE "user_bans" ADD CONSTRAINT "user_bans_channel_check" CHECK ("user_bans"."channel" IN ('web', 'ftp'));--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "timezone" SET DEFAULT 'UTC';
