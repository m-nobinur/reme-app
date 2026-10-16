CREATE TYPE "public"."connect_method" AS ENUM('records', 'domain_connect');--> statement-breakpoint
CREATE TYPE "public"."domain_origin" AS ENUM('connected');--> statement-breakpoint
CREATE TYPE "public"."domain_state" AS ENUM('awaiting_dns', 'verifying', 'active', 'failed', 'removed');--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"primary_host" text NOT NULL,
	"origin" "domain_origin" NOT NULL,
	"method" "connect_method" NOT NULL,
	"state" "domain_state" NOT NULL,
	"on_cloudflare" boolean DEFAULT false NOT NULL,
	"cf_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" jsonb,
	"needs_txt" boolean DEFAULT false NOT NULL,
	"approval_id" uuid,
	"last_check" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "domains_approval_id_unique" UNIQUE("approval_id"),
	CONSTRAINT "domains_name_lowercase_apex" CHECK (name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(name) <= 253 and name not like 'www.%'),
	CONSTRAINT "domains_primary_host_of_name" CHECK (primary_host in (name, 'www.' || name))
);
--> statement-breakpoint
ALTER TABLE "domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_approval_fk" FOREIGN KEY ("approval_id","org_id") REFERENCES "public"."approvals"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_live_name" ON "domains" USING btree ("name") WHERE state not in ('removed', 'failed');--> statement-breakpoint
CREATE INDEX "domains_org_state_idx" ON "domains" USING btree ("org_id","state");--> statement-breakpoint
CREATE POLICY "domains_org_isolation" ON "domains" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Custom SQL below, not generated: drizzle-kit models neither privileges nor
-- definer functions (same as 0009 and 0014).
--
-- The router's way from a custom hostname to a site when KV has no pointer. It
-- runs before any org context exists, so RLS cannot scope it, and the body is
-- the boundary: an active row only, matched on the apex or its `www.`, and
-- three columns back (no cf_ids, approval, provider or check). Same defence as
-- `resolve_org_by_slug` in 0006: `SET search_path = ''`, every relation
-- schema-qualified, STRICT, only `reme_app` may execute it, and no row for a
-- host nothing holds rather than an error.
CREATE FUNCTION public.resolve_domain_host(p_host text)
RETURNS TABLE (org_id uuid, site_id uuid, primary_host text)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select d.org_id, d.site_id, d.primary_host
  from public.domains d
  where d.state = 'active'
    and d.name in (lower(p_host), regexp_replace(lower(p_host), '^www\.', ''))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_domain_host(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_domain_host(text) TO reme_app;
