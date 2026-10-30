CREATE TYPE "public"."grant_kind" AS ENUM('create_reminder', 'record_review', 'connect_domain');--> statement-breakpoint
CREATE TABLE "approval_grants" (
	"org_id" uuid NOT NULL,
	"kind" "grant_kind" NOT NULL,
	"granted_by_staff_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_approval" text,
	CONSTRAINT "approval_grants_org_id_kind_pk" PRIMARY KEY("org_id","kind"),
	CONSTRAINT "approval_grants_source_approval_length" CHECK (char_length(source_approval) between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "approval_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_grants" ADD CONSTRAINT "approval_grants_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_grants" ADD CONSTRAINT "approval_grants_granted_by_fk" FOREIGN KEY ("granted_by_staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "approval_grants_org_isolation" ON "approval_grants" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);