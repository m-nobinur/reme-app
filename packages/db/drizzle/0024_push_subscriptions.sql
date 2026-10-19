ALTER TYPE "public"."delivery_channel" ADD VALUE 'push';--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_org_endpoint_key" UNIQUE("org_id","endpoint"),
	CONSTRAINT "push_subscriptions_endpoint" CHECK (endpoint ~ '^https://' and char_length(endpoint) <= 2000),
	CONSTRAINT "push_subscriptions_keys_length" CHECK (char_length(p256dh) <= 200 and char_length(auth) <= 200)
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_staff_fk" FOREIGN KEY ("staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_staff_idx" ON "push_subscriptions" USING btree ("org_id","staff_id","created_at");--> statement-breakpoint
CREATE POLICY "push_subscriptions_org_isolation" ON "push_subscriptions" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);