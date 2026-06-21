-- Add the per-account secret token. Add nullable first, backfill any existing
-- rows with a random 256-bit token (legacy accounts must re-link to obtain it),
-- then enforce NOT NULL. gen_random_uuid() is built-in on PG13+.
ALTER TABLE "accounts" ADD COLUMN "token" text;
--> statement-breakpoint
UPDATE "accounts"
SET "token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE "token" IS NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "token" SET NOT NULL;
