-- Move the four section tables from a bare `id` primary key to a composite
-- (username, id) primary key so a client-supplied id is unique per-account, not
-- globally (audit #4832/#4855 — cross-account PUT overwrite / shared-import
-- collisions). The old single-column PK index also served the username lookups;
-- the composite PK's leading `username` column now covers those, so the separate
-- per-table username indexes are dropped as redundant.
DROP INDEX "favorites_username_idx";--> statement-breakpoint
DROP INDEX "history_username_idx";--> statement-breakpoint
DROP INDEX "saved_locations_username_idx";--> statement-breakpoint
DROP INDEX "visits_username_idx";--> statement-breakpoint
ALTER TABLE "favorites" DROP CONSTRAINT "favorites_pkey";--> statement-breakpoint
ALTER TABLE "history" DROP CONSTRAINT "history_pkey";--> statement-breakpoint
ALTER TABLE "saved_locations" DROP CONSTRAINT "saved_locations_pkey";--> statement-breakpoint
ALTER TABLE "visits" DROP CONSTRAINT "visits_pkey";--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_username_id_pk" PRIMARY KEY("username","id");--> statement-breakpoint
ALTER TABLE "history" ADD CONSTRAINT "history_username_id_pk" PRIMARY KEY("username","id");--> statement-breakpoint
ALTER TABLE "saved_locations" ADD CONSTRAINT "saved_locations_username_id_pk" PRIMARY KEY("username","id");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_username_id_pk" PRIMARY KEY("username","id");
