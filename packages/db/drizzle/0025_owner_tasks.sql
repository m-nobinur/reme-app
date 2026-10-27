CREATE TYPE "public"."task_blocked_on" AS ENUM('approval', 'owner_action', 'purchase', 'permission');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('address', 'google');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('active', 'done', 'declined', 'later');--> statement-breakpoint
CREATE TYPE "public"."task_step" AS ENUM('find_out', 'choose', 'purchase', 'records', 'ownership', 'certificate', 'loads', 'sign_in', 'permissions', 'verify', 'sitemap', 'first_data');--> statement-breakpoint
CREATE TYPE "public"."task_step_state" AS ENUM('pending', 'in_progress', 'blocked', 'done', 'skipped');--> statement-breakpoint
ALTER TYPE "public"."search_connection_state" ADD VALUE 'needs_permission';--> statement-breakpoint
CREATE TABLE "owner_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "task_kind" NOT NULL,
	"state" "task_state" DEFAULT 'active' NOT NULL,
	"later_until" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "owner_tasks_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "owner_tasks_done_at" CHECK ((state = 'done') = (done_at is not null))
);
--> statement-breakpoint
ALTER TABLE "owner_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_followups" (
	"org_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "task_followups_org_id_fingerprint_pk" PRIMARY KEY("org_id","fingerprint"),
	CONSTRAINT "task_followups_fingerprint" CHECK (char_length(fingerprint) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "task_followups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_steps" (
	"task_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"step" "task_step" NOT NULL,
	"state" "task_step_state" DEFAULT 'pending' NOT NULL,
	"note" text,
	"blocked_on" "task_blocked_on",
	"deadline" timestamp with time zone,
	"evidence" jsonb,
	"probe_hash" text,
	"probed_at" timestamp with time zone,
	"changed_at" timestamp with time zone,
	CONSTRAINT "task_steps_task_id_step_pk" PRIMARY KEY("task_id","step"),
	CONSTRAINT "task_steps_blocked_on" CHECK ((state = 'blocked') = (blocked_on is not null)),
	CONSTRAINT "task_steps_note_length" CHECK (note is null or char_length(note) between 1 and 200),
	CONSTRAINT "task_steps_probe_hash" CHECK (probe_hash is null or probe_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "task_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owner_tasks" ADD CONSTRAINT "owner_tasks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_followups" ADD CONSTRAINT "task_followups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_fk" FOREIGN KEY ("task_id","org_id") REFERENCES "public"."owner_tasks"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_tasks_open_kind" ON "owner_tasks" USING btree ("org_id","kind") WHERE state in ('active', 'later');--> statement-breakpoint
CREATE POLICY "owner_tasks_org_isolation" ON "owner_tasks" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "task_followups_org_isolation" ON "task_followups" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "task_steps_org_isolation" ON "task_steps" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);