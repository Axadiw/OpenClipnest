-- Push through a relay. A self-hosted server cannot deliver to the
-- store-signed apps itself, so it never learns a device's push token: the app
-- registers the token with the relay directly and gives its own server only a
-- public key (payloads are encrypted for it) plus the id the relay knows the
-- device by. Both columns stay NULL for devices that register a raw token.
ALTER TABLE "push_devices" ADD COLUMN IF NOT EXISTS "relay_device_id" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN IF NOT EXISTS "public_key" text;
