-- Custom SQL, not generated: drizzle-kit models neither privileges nor
-- definer functions (ADR-032, amended with the retention sweep).

-- The one read that happens across tenants: every org id, and nothing else.
-- The hourly sweep takes the list and then opens each org's own `withOrg`,
-- so no tenant row is read here and no handle leaves. Same defence as
-- `resolve_org` in 0005 and `resolve_org_by_slug` in 0006: `SET search_path
-- = ''`, the relation schema-qualified, and only `reme_app` may execute it.
CREATE FUNCTION public.list_org_ids() RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select o.id from public.orgs o order by o.created_at, o.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_org_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_org_ids() TO reme_app;
