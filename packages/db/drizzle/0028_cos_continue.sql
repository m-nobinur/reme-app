ALTER TYPE "public"."job_kind" ADD VALUE 'cos_continue';--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD COLUMN "payload" jsonb;