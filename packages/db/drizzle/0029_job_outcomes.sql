ALTER TABLE "job_runs" ALTER COLUMN "outcome" SET DATA TYPE text;--> statement-breakpoint
UPDATE "job_runs" SET "outcome" = CASE "outcome" WHEN 'ok' THEN 'done' WHEN 'skipped' THEN 'no_change' ELSE "outcome" END;--> statement-breakpoint
DROP TYPE "public"."job_outcome";--> statement-breakpoint
CREATE TYPE "public"."job_outcome" AS ENUM('done', 'no_change', 'failed', 'unknown');--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "outcome" SET DATA TYPE "public"."job_outcome" USING "outcome"::"public"."job_outcome";
