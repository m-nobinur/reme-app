ALTER TABLE "assignments" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
CREATE INDEX "events_assignment_type_idx" ON "events" USING btree ("assignment_id","type");--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_cost_nonnegative" CHECK (cost_usd >= 0);