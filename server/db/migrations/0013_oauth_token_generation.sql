-- Capture the user's global token_generation at OAuth grant issuance so the MCP
-- bearer-auth path can revoke phished grants the instant the user rotates
-- credentials (password change, passkey removal, account deletion, POST
-- /auth/logout all bump users.token_generation). Without this the access /
-- refresh token pair keeps working for up to 30 days regardless of revocation.
--
-- The value is frozen at grant creation and carried forward unchanged across
-- refresh-token rotations, so a bump on the user row strictly exceeds the stored
-- generation and both the bearer path and the token-refresh path start rejecting.
-- Backfill of existing rows to the user's CURRENT generation would be wrong (it
-- would immunise already-issued tokens against the next bump); DEFAULT 0 means
-- any pre-existing token is treated as generation 0 and is revoked by the first
-- bump — the safe direction.
ALTER TABLE "oauth_access_tokens" ADD COLUMN "token_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "token_generation" integer DEFAULT 0 NOT NULL;
