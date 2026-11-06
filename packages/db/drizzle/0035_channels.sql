CREATE TYPE "public"."channel_kind" AS ENUM('whatsapp', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_account_source" AS ENUM('connected', 'purchased', 'dev');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_account_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "channel_inbound" (
	"org_id" uuid NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"external_message_id" text NOT NULL,
	"link_id" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "channel_inbound_pkey" PRIMARY KEY("org_id","kind","external_message_id"),
	CONSTRAINT "channel_inbound_external_message_id_length" CHECK (char_length(external_message_id) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "channel_inbound" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_link_codes" (
	"hash" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_link_codes_hash" CHECK (hash ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "channel_link_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"label" text NOT NULL,
	"conversation_id" uuid,
	"last_inbound_at" timestamp with time zone,
	"updates" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "channel_links_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "channel_links_external_id" CHECK (external_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "channel_links_label_length" CHECK (char_length(label) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "channel_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_number" text NOT NULL,
	"display_name" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"source" "whatsapp_account_source" NOT NULL,
	"coexistence" boolean DEFAULT false NOT NULL,
	"status" "whatsapp_account_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_accounts_org_key" UNIQUE("org_id"),
	CONSTRAINT "whatsapp_accounts_phone_number_key" UNIQUE("phone_number_id"),
	CONSTRAINT "whatsapp_accounts_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "whatsapp_accounts_meta_ids" CHECK (waba_id ~ '^[0-9]{1,32}$' and phone_number_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "whatsapp_accounts_display_number_e164" CHECK (display_number ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "whatsapp_accounts_display_name_length" CHECK (char_length(display_name) between 1 and 100),
	CONSTRAINT "whatsapp_accounts_token_sealed" CHECK (token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);
--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_inbound" ADD CONSTRAINT "channel_inbound_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_inbound" ADD CONSTRAINT "channel_inbound_link_fk" FOREIGN KEY ("link_id","org_id") REFERENCES "public"."channel_links"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_codes" ADD CONSTRAINT "channel_link_codes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_codes" ADD CONSTRAINT "channel_link_codes_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_account_fk" FOREIGN KEY ("account_id","org_id") REFERENCES "public"."whatsapp_accounts"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_conversation_fk" FOREIGN KEY ("conversation_id","org_id") REFERENCES "public"."conversations"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_inbound_waiting_idx" ON "channel_inbound" USING btree ("link_id","received_at") WHERE processed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_live_sender" ON "channel_links" USING btree ("account_id","external_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE POLICY "channel_inbound_org_isolation" ON "channel_inbound" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "channel_link_codes_org_isolation" ON "channel_link_codes" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "channel_links_org_isolation" ON "channel_links" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "whatsapp_accounts_org_isolation" ON "whatsapp_accounts" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- Custom SQL below, not generated (same as 0020): drizzle-kit models neither
-- privileges nor definer functions.
--
-- The webhook's three reads before any org context exists. Each body is the
-- boundary, with the defence of 0015: `SET search_path = ''`, schema-qualified,
-- STRICT, only `reme_app` may execute, and no row rather than an error for
-- anything it does not answer.
--
-- An active account's id and org from Meta's phone number id.
CREATE FUNCTION public.whatsapp_account_by_phone(p_phone_number_id text)
RETURNS TABLE (account_id uuid, org_id uuid)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select a.id, a.org_id
  from public.whatsapp_accounts a
  where a.phone_number_id = p_phone_number_id
    and a.status = 'active'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.whatsapp_account_by_phone(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.whatsapp_account_by_phone(text) TO reme_app;
--> statement-breakpoint
-- A sender's live link on that account.
CREATE FUNCTION public.channel_link_of(p_account_id uuid, p_external_id text)
RETURNS TABLE (link_id uuid, org_id uuid, user_id uuid)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select l.id, l.org_id, l.user_id
  from public.channel_links l
  where l.account_id = p_account_id
    and l.external_id = p_external_id
    and l.revoked_at is null
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.channel_link_of(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.channel_link_of(uuid, text) TO reme_app;
--> statement-breakpoint
-- Spends a code and links the sender, in one statement: an unused, unexpired
-- WhatsApp code of an active member, redeemed on an active account of the
-- code's own org. The row lock on the code makes a second redeem find it used.
-- A sender already live on the account moves to the code's person.
CREATE FUNCTION public.redeem_channel_code(
  p_hash text,
  p_account_id uuid,
  p_external_id text,
  p_label text
)
RETURNS TABLE (link_id uuid, org_id uuid, user_id uuid)
LANGUAGE sql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  with spent as (
    update public.channel_link_codes c
    set used_at = now()
    where c.hash = p_hash
      and c.kind = 'whatsapp'
      and c.used_at is null
      and c.expires_at > now()
      and exists (
        select 1 from public.whatsapp_accounts a
        where a.id = p_account_id and a.org_id = c.org_id and a.status = 'active'
      )
      and exists (
        select 1 from public.memberships m
        where m.org_id = c.org_id and m.user_id = c.user_id and m.status = 'active'
      )
    returning c.org_id, c.user_id
  )
  insert into public.channel_links as l (org_id, user_id, account_id, external_id, label)
  select s.org_id, s.user_id, p_account_id, p_external_id, p_label
  from spent s
  on conflict (account_id, external_id) where revoked_at is null
  do update set user_id = excluded.user_id, label = excluded.label
  returning l.id, l.org_id, l.user_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.redeem_channel_code(text, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.redeem_channel_code(text, uuid, text, text) TO reme_app;
