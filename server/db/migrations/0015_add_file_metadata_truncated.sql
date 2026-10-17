-- Mark an upload the client cut short. FTPS now commits whatever bytes
-- arrived instead of discarding them (a camera on a slow uplink gives an
-- event ~25 s and then kills whatever is still streaming), so a row can
-- describe a genuinely shorter clip than the camera recorded. Without this
-- flag a half recording is indistinguishable from a complete one.
--
-- Cleared back to false if the same s3_key is later re-uploaded in full
-- (FTPS `put` is idempotent on the key), so it always reflects the object
-- currently in the bucket.
ALTER TABLE "file_metadata" ADD COLUMN "truncated" boolean DEFAULT false NOT NULL;
