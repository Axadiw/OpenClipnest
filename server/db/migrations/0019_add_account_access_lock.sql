-- An account whose access is locked keeps signing in and sees its list of
-- recordings and their thumbnails, but cannot play, download or delete
-- recordings, cannot upload, and cannot use FTP or the MCP server. NULL means
-- full access. The value is the moment the lock started, so a later retention
-- step can count from it. Additive only: code that predates it ignores it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_locked_at" timestamp with time zone;
