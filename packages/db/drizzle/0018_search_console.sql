CREATE TYPE "public"."search_connection_state" AS ENUM('active', 'needs_reauth', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."search_property_kind" AS ENUM('subdomain', 'domain', 'url_prefix');--> statement-breakpoint
CREATE TYPE "public"."search_property_state" AS ENUM('pending', 'verified', 'failed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."search_verify_method" AS ENUM('file', 'dns_txt');--> statement-breakpoint
CREATE TABLE "search_connections" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"connected_by_user_id" uuid,
	"google_email" text,
	"refresh_token" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" "search_connection_state" NOT NULL,
	"connected_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"asked_at" timestamp with time zone,
	"declined" boolean DEFAULT false NOT NULL,
	CONSTRAINT "search_connections_token_sealed" CHECK (refresh_token is null or refresh_token ~ '^v1\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+$'),
	CONSTRAINT "search_connections_token_by_state" CHECK ((state::text = 'revoked') = (refresh_token is null))
);
--> statement-breakpoint
ALTER TABLE "search_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_daily" (
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"date" date NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	CONSTRAINT "search_daily_org_id_property_id_date_pk" PRIMARY KEY("org_id","property_id","date"),
	CONSTRAINT "search_daily_counts" CHECK (clicks >= 0 and impressions >= 0)
);
--> statement-breakpoint
ALTER TABLE "search_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"host" text NOT NULL,
	"site_url" text NOT NULL,
	"kind" "search_property_kind" NOT NULL,
	"method" "search_verify_method" NOT NULL,
	"token" text,
	"state" "search_property_state" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"sitemap" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_properties_org_site_url" UNIQUE("org_id","site_url"),
	CONSTRAINT "search_properties_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "search_properties_site_url_shape" CHECK (site_url ~ '^(sc-domain:[a-z0-9.-]+|https://[^[:space:]/]+/)$' and char_length(site_url) <= 300),
	CONSTRAINT "search_properties_method_of_kind" CHECK ((kind::text = 'domain') = (method::text = 'dns_txt'))
);
--> statement-breakpoint
ALTER TABLE "search_properties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_snapshot" (
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"query" text NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	"window_end" date NOT NULL,
	CONSTRAINT "search_snapshot_org_id_property_id_query_page_pk" PRIMARY KEY("org_id","property_id","query","page"),
	CONSTRAINT "search_snapshot_counts" CHECK (clicks >= 0 and impressions >= 0)
);
--> statement-breakpoint
ALTER TABLE "search_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_url_status" (
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"url" text NOT NULL,
	"verdict" text NOT NULL,
	"coverage_state" text,
	"indexing_state" text,
	"robots_state" text,
	"google_canonical" text,
	"last_crawl_time" timestamp with time zone,
	"inspected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "search_url_status_org_id_property_id_url_pk" PRIMARY KEY("org_id","property_id","url")
);
--> statement-breakpoint
ALTER TABLE "search_url_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_connections" ADD CONSTRAINT "search_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_connections" ADD CONSTRAINT "search_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_daily" ADD CONSTRAINT "search_daily_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_daily" ADD CONSTRAINT "search_daily_property_fk" FOREIGN KEY ("property_id","org_id") REFERENCES "public"."search_properties"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_properties" ADD CONSTRAINT "search_properties_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_snapshot" ADD CONSTRAINT "search_snapshot_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_snapshot" ADD CONSTRAINT "search_snapshot_property_fk" FOREIGN KEY ("property_id","org_id") REFERENCES "public"."search_properties"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_url_status" ADD CONSTRAINT "search_url_status_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_url_status" ADD CONSTRAINT "search_url_status_property_fk" FOREIGN KEY ("property_id","org_id") REFERENCES "public"."search_properties"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "search_connections_org_isolation" ON "search_connections" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "search_daily_org_isolation" ON "search_daily" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "search_properties_org_isolation" ON "search_properties" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "search_snapshot_org_isolation" ON "search_snapshot" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "search_url_status_org_isolation" ON "search_url_status" AS PERMISSIVE FOR ALL TO public USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);