-- Plan catalog: what a plan shows and costs, kept next to its limits so the
-- pricing page and checkout read one source. is_public = listed publicly;
-- sort_order = display order; monthly_price_cents + currency = the price a
-- customer pays (tax included); price_lookup_key = the key of the matching
-- price at the payment provider. A plan without a price is not sold.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "monthly_price_cents" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "price_lookup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plans_price_lookup_key_unique" ON "plans" ("price_lookup_key") WHERE "price_lookup_key" IS NOT NULL;--> statement-breakpoint
-- Catalog v2. Users keep their plan row: Pro becomes Plus and the old Max
-- becomes Ultra by renaming the row, so nobody's plan_id changes. A rename
-- only happens while the new name is free (re-runs and hand-made plans are
-- left alone).
UPDATE "plans" SET "name" = 'Ultra', "disk_space_bytes" = 1099511627776, "monthly_transfer_bytes" = 2199023255552
  WHERE "name" = 'Max' AND NOT EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Ultra');--> statement-breakpoint
-- A plan named 'Plus' made by hand before this catalog (recognisable because
-- 'Pro' still exists) is folded into Ultra: its users and invite codes move
-- to Ultra and the row goes, so the name is free for the renamed Pro.
UPDATE "users" SET "plan_id" = (SELECT "id" FROM "plans" WHERE "name" = 'Ultra')
  WHERE "plan_id" = (SELECT "id" FROM "plans" WHERE "name" = 'Plus')
    AND EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Pro')
    AND EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Ultra');--> statement-breakpoint
UPDATE "invite_codes" SET "plan_id" = (SELECT "id" FROM "plans" WHERE "name" = 'Ultra')
  WHERE "plan_id" = (SELECT "id" FROM "plans" WHERE "name" = 'Plus')
    AND EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Pro')
    AND EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Ultra');--> statement-breakpoint
DELETE FROM "plans" AS p
  WHERE p."name" = 'Plus'
    AND EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Pro')
    AND NOT EXISTS (SELECT 1 FROM "users" WHERE "plan_id" = p."id")
    AND NOT EXISTS (SELECT 1 FROM "invite_codes" WHERE "plan_id" = p."id");--> statement-breakpoint
UPDATE "plans" SET "name" = 'Plus', "disk_space_bytes" = 21474836480, "monthly_transfer_bytes" = 42949672960
  WHERE "name" = 'Pro' AND NOT EXISTS (SELECT 1 FROM "plans" WHERE "name" = 'Plus');--> statement-breakpoint
UPDATE "plans" SET "disk_space_bytes" = 5368709120, "monthly_transfer_bytes" = 10737418240
  WHERE "name" = 'Basic';--> statement-breakpoint
INSERT INTO "plans" ("name", "disk_space_bytes", "monthly_transfer_bytes") VALUES
  ('Basic', 5368709120, 10737418240),
  ('Plus', 21474836480, 42949672960),
  ('Max', 107374182400, 214748364800),
  ('Ultra', 1099511627776, 2199023255552)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
UPDATE "plans" AS p SET "is_public" = true, "sort_order" = v.sort_order, "monthly_price_cents" = v.price,
       "currency" = 'EUR', "price_lookup_key" = v.lookup_key
  FROM (VALUES ('Basic', 10, 999, 'basic_monthly'),
               ('Plus', 20, 1999, 'plus_monthly'),
               ('Max', 30, 4999, 'max_monthly'),
               ('Ultra', 40, 19999, 'ultra_monthly')) AS v(name, sort_order, price, lookup_key)
  WHERE p."name" = v.name;--> statement-breakpoint
UPDATE "plans" SET "sort_order" = 1000, "is_public" = false WHERE "name" = 'Tiny';--> statement-breakpoint
-- A plan is either sold (both a price and the payment provider's price key)
-- or granted by hand only (neither); a public plan must be one that is sold.
-- Added after the data statements above, which leave every row satisfying both.
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_price_pair_check";--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_price_pair_check" CHECK (("monthly_price_cents" IS NULL) = ("price_lookup_key" IS NULL));--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_public_needs_price_check";--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_public_needs_price_check" CHECK (NOT "is_public" OR "price_lookup_key" IS NOT NULL);
