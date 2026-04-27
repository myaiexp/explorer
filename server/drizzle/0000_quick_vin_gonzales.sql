CREATE TABLE "accounts" (
	"username" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_first_seen" "inet"
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"start_lat" double precision NOT NULL,
	"start_lng" double precision NOT NULL,
	"start_label" text,
	"dest_lat" double precision NOT NULL,
	"dest_lng" double precision NOT NULL,
	"dest_name" text,
	"trip_mode" text,
	"distance" double precision NOT NULL,
	"route_coords" jsonb,
	"route_duration" double precision,
	"return_route_coords" jsonb,
	"return_route_duration" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"start_lat" double precision NOT NULL,
	"start_lng" double precision NOT NULL,
	"start_label" text,
	"dest_lat" double precision NOT NULL,
	"dest_lng" double precision NOT NULL,
	"dest_name" text,
	"poi_category" text,
	"trip_mode" text,
	"distance" double precision NOT NULL,
	"route_coords" jsonb,
	"route_duration" double precision,
	"return_route_coords" jsonb,
	"return_route_duration" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_username_accounts_username_fk" FOREIGN KEY ("username") REFERENCES "public"."accounts"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history" ADD CONSTRAINT "history_username_accounts_username_fk" FOREIGN KEY ("username") REFERENCES "public"."accounts"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_locations" ADD CONSTRAINT "saved_locations_username_accounts_username_fk" FOREIGN KEY ("username") REFERENCES "public"."accounts"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_username_accounts_username_fk" FOREIGN KEY ("username") REFERENCES "public"."accounts"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "favorites_username_idx" ON "favorites" USING btree ("username");--> statement-breakpoint
CREATE INDEX "history_username_idx" ON "history" USING btree ("username");--> statement-breakpoint
CREATE INDEX "saved_locations_username_idx" ON "saved_locations" USING btree ("username");--> statement-breakpoint
CREATE INDEX "visits_username_idx" ON "visits" USING btree ("username");