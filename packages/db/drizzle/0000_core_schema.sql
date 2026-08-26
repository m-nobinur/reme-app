CREATE TYPE "public"."fact_source" AS ENUM('owner_stated', 'document', 'integration', 'inferred');--> statement-breakpoint
CREATE TYPE "public"."staff_event_kind" AS ENUM('hired', 'configured', 'paused', 'resumed', 'reassigned', 'evaluated', 'offboarded', 'credential_revoked');--> statement-breakpoint
CREATE TYPE "public"."staff_kind" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('draft', 'onboarding', 'active', 'paused', 'suspended', 'offboarding', 'archived');--> statement-breakpoint
CREATE TYPE "public"."taint_label" AS ENUM('untrusted_input', 'external_content', 'inferred', 'quarantined');--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "departments_org_name_key" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" char(26) PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"staff_id" uuid,
	"assignment_id" uuid,
	"session_id" uuid,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" char(26) NOT NULL,
	"taint" "taint_label"[] DEFAULT '{}' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "events_org_idempotency_key" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "events_seq_nonnegative" CHECK (seq >= 0),
	CONSTRAINT "events_id_is_ulid" CHECK (event_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "events_idempotency_key_is_ulid" CHECK (idempotency_key ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "events_type_is_dotted" CHECK (type ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fact_type" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"provenance_source" "fact_source" NOT NULL,
	"provenance_confidence" double precision NOT NULL,
	"verified_by_staff_id" uuid,
	"verified_at" timestamp with time zone,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"superseded_by_fact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "facts_org_key_version_key" UNIQUE("org_id","key","version"),
	CONSTRAINT "facts_version_positive" CHECK (version > 0),
	CONSTRAINT "facts_confidence_range" CHECK (provenance_confidence >= 0 and provenance_confidence <= 1)
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"default_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_runtime_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_org_key_version_key" UNIQUE NULLS NOT DISTINCT("org_id","key","version"),
	CONSTRAINT "roles_version_positive" CHECK (version > 0)
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"staff_code" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" "staff_kind" NOT NULL,
	"user_id" uuid,
	"role_id" uuid,
	"department_id" uuid,
	"manager_id" uuid,
	"position_title" text,
	"status" "staff_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "staff_org_code_key" UNIQUE("org_id","staff_code")
);
--> statement-breakpoint
CREATE TABLE "staff_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" "staff_event_kind" NOT NULL,
	"actor_staff_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workos_user_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "users_org_workos_user_key" UNIQUE("org_id","workos_user_id"),
	CONSTRAINT "users_org_email_key" UNIQUE("org_id","email")
);
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_fk" FOREIGN KEY ("parent_id","org_id") REFERENCES "public"."departments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_staff_fk" FOREIGN KEY ("staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_superseded_by_fk" FOREIGN KEY ("superseded_by_fact_id","org_id") REFERENCES "public"."facts"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_verified_by_fk" FOREIGN KEY ("verified_by_staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_manager_fk" FOREIGN KEY ("manager_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_department_fk" FOREIGN KEY ("department_id","org_id") REFERENCES "public"."departments"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_fk" FOREIGN KEY ("user_id","org_id") REFERENCES "public"."users"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_events" ADD CONSTRAINT "staff_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_events" ADD CONSTRAINT "staff_events_staff_fk" FOREIGN KEY ("staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_events" ADD CONSTRAINT "staff_events_actor_fk" FOREIGN KEY ("actor_staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_session_seq_key" ON "events" USING btree ("session_id","seq") WHERE session_id is not null;--> statement-breakpoint
CREATE INDEX "events_org_occurred_idx" ON "events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "facts_one_current_per_key" ON "facts" USING btree ("org_id","key") WHERE valid_to is null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_one_root_per_org" ON "staff" USING btree ("org_id") WHERE manager_id is null;--> statement-breakpoint
CREATE INDEX "staff_org_manager_idx" ON "staff" USING btree ("org_id","manager_id");--> statement-breakpoint
CREATE INDEX "staff_events_staff_idx" ON "staff_events" USING btree ("org_id","staff_id","occurred_at");--> statement-breakpoint
CREATE INDEX "users_workos_user_idx" ON "users" USING btree ("workos_user_id");