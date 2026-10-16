ALTER TYPE "public"."connect_method" ADD VALUE 'purchased';--> statement-breakpoint
ALTER TYPE "public"."domain_origin" ADD VALUE 'purchased';--> statement-breakpoint
ALTER TYPE "public"."domain_state" ADD VALUE 'awaiting_payment' BEFORE 'awaiting_dns';--> statement-breakpoint
ALTER TYPE "public"."domain_state" ADD VALUE 'abandoned' BEFORE 'removed';--> statement-breakpoint
DROP INDEX "domains_live_name";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "stripe" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "price" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "registration" jsonb;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_live_name" ON "domains" USING btree ("name") WHERE state < 'failed';--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_stripe_customer_key" UNIQUE("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_purchase_shape" CHECK ((origin::text = 'purchased') = (method::text = 'purchased') and (origin::text <> 'purchased' or price is not null) and (origin::text = 'purchased' or state::text not in ('awaiting_payment', 'abandoned')));