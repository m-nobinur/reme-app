CREATE TYPE "public"."assignment_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."assignment_state" AS ENUM('queued', 'briefing', 'planning', 'implementing', 'validating', 'preview_ready', 'awaiting_review', 'revising', 'release_candidate', 'published', 'blocked_on_information', 'blocked_on_approval', 'repairing', 'paused', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."site_revision_status" AS ENUM('building', 'preview', 'published', 'retired');--> statement-breakpoint
-- Before the tables: assignment_transitions cites (event_id, org_id) below.
ALTER TABLE "events" ADD CONSTRAINT "events_id_org_key" UNIQUE("event_id","org_id");--> statement-breakpoint
CREATE TABLE "assignment_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"from_state" "assignment_state" NOT NULL,
	"to_state" "assignment_state" NOT NULL,
	"version" integer NOT NULL,
	"event_id" char(26) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_transitions_version_key" UNIQUE("assignment_id","version")
);
--> statement-breakpoint
ALTER TABLE "assignment_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"created_by_staff_id" uuid NOT NULL,
	"parent_assignment_id" uuid,
	"revision_of_assignment_id" uuid,
	"kind" text NOT NULL,
	"state" "assignment_state" DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"goal" text NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"fact_snapshot_id" uuid NOT NULL,
	"pack_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_usd" double precision NOT NULL,
	"deadline" timestamp with time zone,
	"priority" "assignment_priority" DEFAULT 'normal' NOT NULL,
	"workflow_instance_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "assignments_org_idempotency_key" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "assignments_kind_is_dotted" CHECK (kind ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'),
	CONSTRAINT "assignments_budget_positive" CHECK (budget_usd > 0),
	CONSTRAINT "assignments_version_nonnegative" CHECK (version >= 0)
);
--> statement-breakpoint
ALTER TABLE "assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"summary" text,
	"source_key" text NOT NULL,
	"artifact_prefix" text NOT NULL,
	"manifest_key" text NOT NULL,
	"status" "site_revision_status" DEFAULT 'building' NOT NULL,
	"retire_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_revisions_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "site_revisions_site_version_key" UNIQUE("site_id","version"),
	CONSTRAINT "site_revisions_version_positive" CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE "site_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assignment_transitions" ADD CONSTRAINT "assignment_transitions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_transitions" ADD CONSTRAINT "assignment_transitions_assignment_fk" FOREIGN KEY ("assignment_id","org_id") REFERENCES "public"."assignments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_transitions" ADD CONSTRAINT "assignment_transitions_event_fk" FOREIGN KEY ("event_id","org_id") REFERENCES "public"."events"("event_id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_staff_fk" FOREIGN KEY ("staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_fk" FOREIGN KEY ("created_by_staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_parent_fk" FOREIGN KEY ("parent_assignment_id","org_id") REFERENCES "public"."assignments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_revision_of_fk" FOREIGN KEY ("revision_of_assignment_id","org_id") REFERENCES "public"."assignments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_revisions" ADD CONSTRAINT "site_revisions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_revisions" ADD CONSTRAINT "site_revisions_assignment_fk" FOREIGN KEY ("assignment_id","org_id") REFERENCES "public"."assignments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_transitions_to_state_idx" ON "assignment_transitions" USING btree ("assignment_id","to_state");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_site_writer_key" ON "assignments" USING btree ("org_id") WHERE kind like 'site.%' and state not in ('queued', 'paused', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE POLICY "assignment_transitions_org_isolation" ON "assignment_transitions" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assignments_org_isolation" ON "assignments" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "site_revisions_org_isolation" ON "site_revisions" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The builder console addresses a business by slug and holds no session, so
-- this is the second read that has to happen before an org context exists.
-- Same defence as `resolve_org` in 0005: `SET search_path = ''`, every relation
-- schema-qualified, STRICT, and a null for a slug nothing holds rather than an
-- error a caller could enumerate against.
CREATE FUNCTION public.resolve_org_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select o.id from public.orgs o where o.slug = p_slug
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_org_by_slug(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_org_by_slug(text) TO reme_app;
