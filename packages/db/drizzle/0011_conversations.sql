CREATE TYPE "public"."conversation_kind" AS ENUM('onboarding', 'assistant');--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"conversation_id" uuid NOT NULL,
	"id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" text,
	"format" text NOT NULL,
	"content" jsonb NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "conversation_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_pkey" PRIMARY KEY("conversation_id","id"),
	CONSTRAINT "conversation_messages_ids_are_text_ids" CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$' and parent_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "conversation_messages_not_own_parent" CHECK (parent_id <> id)
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"title" text,
	"created_by_staff_id" uuid NOT NULL,
	"idempotency_key" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "conversations_org_idempotency_key" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "conversations_idempotency_key_length" CHECK (char_length(idempotency_key) between 1 and 255),
	CONSTRAINT "conversations_title_text" CHECK (char_length(title) between 1 and 120 and title ~ '[^ \t\n\v\f\r]')
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_fk" FOREIGN KEY ("conversation_id","org_id") REFERENCES "public"."conversations"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_parent_fk" FOREIGN KEY ("conversation_id","parent_id") REFERENCES "public"."conversation_messages"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_fk" FOREIGN KEY ("created_by_staff_id","org_id") REFERENCES "public"."staff"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_seq_idx" ON "conversation_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_onboarding_per_org" ON "conversations" USING btree ("org_id") WHERE kind = 'onboarding';--> statement-breakpoint
CREATE INDEX "conversations_org_updated_idx" ON "conversations" USING btree ("org_id","updated_at","id");--> statement-breakpoint
CREATE POLICY "conversation_messages_org_isolation" ON "conversation_messages" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "conversations_org_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);