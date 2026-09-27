CREATE TYPE "public"."reminder_source" AS ENUM('owner', 'assistant');--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"source" "reminder_source" NOT NULL,
	"conversation_id" uuid,
	"created_by_staff_id" uuid NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_org_idempotency_key" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "reminders_idempotency_key_length" CHECK (char_length(idempotency_key) between 1 and 255),
	CONSTRAINT "reminders_title_text" CHECK (char_length(title) between 1 and 200 and title ~ '[^ \t\n\v\f\r]')
);
--> statement-breakpoint
ALTER TABLE "reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_conversation_fk" FOREIGN KEY ("conversation_id","org_id") REFERENCES "public"."conversations"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_fk" FOREIGN KEY ("created_by_staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_org_done_due_idx" ON "reminders" USING btree ("org_id","done_at","due_at");--> statement-breakpoint
CREATE POLICY "reminders_org_isolation" ON "reminders" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);