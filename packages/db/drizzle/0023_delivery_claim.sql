ALTER TYPE "public"."delivery_state" ADD VALUE 'sending' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."delivery_state" ADD VALUE 'unknown' BEFORE 'sent';--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "payload" jsonb;