CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workos_membership_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workos_membership_key" UNIQUE("workos_membership_id"),
	CONSTRAINT "memberships_org_user_key" UNIQUE("org_id","user_id"),
	CONSTRAINT "memberships_org_membership_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Two statements moved ahead of where drizzle-kit emitted them, because
-- `users.org_id` is not free to go until nothing depends on it. Each raised
-- 2BP01 in the order it was generated: `staff_user_fk` points at
-- `users_id_org_key`, and `users_org_isolation` reads the column.
ALTER TABLE "staff" DROP CONSTRAINT "staff_user_fk";
--> statement-breakpoint
DROP POLICY "users_org_isolation" ON "users" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_id_org_key";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_org_workos_user_key";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_org_email_key";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_org_id_orgs_id_fk";
--> statement-breakpoint
DROP INDEX "users_workos_user_idx";--> statement-breakpoint
DROP INDEX "events_session_seq_key";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "seq" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_session_seq_key" ON "events" USING btree ("session_id","seq");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workos_user_key" UNIQUE("workos_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_seq_pairs_with_session" CHECK ((session_id is null) = (seq is null));--> statement-breakpoint
CREATE POLICY "users_member_read" ON "users" AS PERMISSIVE FOR SELECT TO public USING (exists (
        select 1 from memberships m
        where m.user_id = users.id and m.org_id = nullif(current_setting('app.org_id', true), '')::uuid
      ));--> statement-breakpoint
CREATE POLICY "users_self_insert" ON "users" AS PERMISSIVE FOR INSERT TO public WITH CHECK (workos_user_id = nullif(current_setting('app.workos_user_id', true), ''));--> statement-breakpoint
CREATE POLICY "users_self_update" ON "users" AS PERMISSIVE FOR UPDATE TO public USING (workos_user_id = nullif(current_setting('app.workos_user_id', true), '')) WITH CHECK (workos_user_id = nullif(current_setting('app.workos_user_id', true), ''));--> statement-breakpoint
CREATE POLICY "memberships_org_isolation" ON "memberships" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);