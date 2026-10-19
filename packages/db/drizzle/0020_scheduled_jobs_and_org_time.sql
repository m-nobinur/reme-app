CREATE TYPE "public"."delivery_channel" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('pending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('reminder', 'heartbeat', 'weekly_report');--> statement-breakpoint
CREATE TYPE "public"."job_outcome" AS ENUM('ok', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proactivity" AS ENUM('off', 'low', 'default', 'high');--> statement-breakpoint
CREATE TABLE "deliveries" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"state" "delivery_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "deliveries_pkey" PRIMARY KEY("org_id","key"),
	CONSTRAINT "deliveries_key_length" CHECK (char_length(key) between 1 and 200),
	CONSTRAINT "deliveries_attempts_count" CHECK (attempts >= 0),
	CONSTRAINT "deliveries_error_length" CHECK (char_length(error) <= 500)
);
--> statement-breakpoint
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_runs" (
	"job_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"outcome" "job_outcome" NOT NULL,
	"detail" text,
	CONSTRAINT "job_runs_pkey" PRIMARY KEY("job_id","run_at"),
	CONSTRAINT "job_runs_detail_length" CHECK (char_length(detail) <= 500)
);
--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"ref_id" uuid,
	"rule" text,
	"next_run_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_jobs_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "scheduled_jobs_rule_length" CHECK (char_length(rule) between 1 and 200),
	CONSTRAINT "scheduled_jobs_failures_count" CHECK (failures >= 0)
);
--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "quiet_start" text DEFAULT '21:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "quiet_end" text DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "proactivity" "proactivity" DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_fk" FOREIGN KEY ("job_id","org_id") REFERENCES "public"."scheduled_jobs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("next_run_at") WHERE paused_at is null;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_time_zone_name" CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_quiet_hours_time" CHECK (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
CREATE POLICY "deliveries_org_isolation" ON "deliveries" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "job_runs_org_isolation" ON "job_runs" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scheduled_jobs_org_isolation" ON "scheduled_jobs" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- Custom SQL below, not generated (same as 0009): drizzle-kit models neither
-- privileges nor definer functions.

-- The second read that crosses tenants: the jobs that are due, as ids. One
-- statement, because Hyperdrive allows no advisory lock across statements:
-- the rows are locked with SKIP LOCKED and marked in the same UPDATE, so a
-- second caller, concurrent or later, does not see them. A claim older than
-- 20 minutes counts as dead and the job is due again: a Queue consumer has
-- 15 minutes of wall time, so a live run is never claimed twice. The WHERE is
-- re-checked against a row a concurrent claimer has just committed, which is
-- what keeps two callers from taking the same row. Same defence as
-- `list_org_ids`: `SET search_path = ''`, schema-qualified relations, only
-- `reme_app` may execute it, and only ids come back. The cap bounds one call
-- whatever the caller asks.
CREATE FUNCTION public.claim_due_jobs(max_jobs integer)
RETURNS TABLE (job_id uuid, org_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  with due as (
    select j.id
    from public.scheduled_jobs j
    where j.paused_at is null
      and j.next_run_at <= now()
      and (j.claimed_at is null or j.claimed_at < now() - interval '20 minutes')
    order by j.next_run_at, j.id
    limit least(greatest(max_jobs, 0), 500)
    for update skip locked
  )
  update public.scheduled_jobs j
  set claimed_at = now()
  from due
  where j.id = due.id
  returning j.id, j.org_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_due_jobs(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_due_jobs(integer) TO reme_app;