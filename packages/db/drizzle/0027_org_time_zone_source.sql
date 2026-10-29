ALTER TABLE "orgs" ADD COLUMN "time_zone_source" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_time_zone_source_kind" CHECK (time_zone_source in ('browser', 'area', 'owner'));