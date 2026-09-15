CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."deployment_kind" AS ENUM('publish', 'rollback');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"assignment_id" uuid,
	"requested_by_staff_id" uuid NOT NULL,
	"approver_staff_id" uuid NOT NULL,
	"action_kind" text NOT NULL,
	"target" jsonb NOT NULL,
	"revision_id" uuid,
	"rationale" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decision" "approval_decision",
	"decided_by" jsonb,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "approvals_revision_matches_target" CHECK (coalesce(target->>'kind' = 'revision', false) = (revision_id is not null) and (revision_id is null or revision_id::text = target->>'revision_id')),
	CONSTRAINT "approvals_decision_complete" CHECK ((decision is null) = (decided_by is null) and (decision is null) = (decided_at is null)),
	CONSTRAINT "approvals_expires_after_request" CHECK (expires_at > requested_at)
);
--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"previous_revision_id" uuid,
	"config_version" integer NOT NULL,
	"kind" "deployment_kind" NOT NULL,
	"approval_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_site_config_version_key" UNIQUE("site_id","config_version"),
	CONSTRAINT "deployments_publish_has_approval" CHECK ((kind = 'publish') = (approval_id is not null)),
	CONSTRAINT "deployments_config_version_positive" CHECK (config_version > 0)
);
--> statement-breakpoint
ALTER TABLE "deployments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_assignment_fk" FOREIGN KEY ("assignment_id","org_id") REFERENCES "public"."assignments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revision_fk" FOREIGN KEY ("revision_id","org_id") REFERENCES "public"."site_revisions"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_revision_fk" FOREIGN KEY ("revision_id","org_id") REFERENCES "public"."site_revisions"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_previous_revision_fk" FOREIGN KEY ("previous_revision_id","org_id") REFERENCES "public"."site_revisions"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_approval_fk" FOREIGN KEY ("approval_id","org_id") REFERENCES "public"."approvals"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_open_per_revision" ON "approvals" USING btree ("revision_id") WHERE decision is null and revision_id is not null;--> statement-breakpoint
CREATE POLICY "approvals_org_isolation" ON "approvals" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "deployments_org_isolation" ON "deployments" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);