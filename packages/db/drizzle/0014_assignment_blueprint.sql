ALTER TABLE "assignments" ADD COLUMN "blueprint" jsonb;--> statement-breakpoint
-- Custom SQL below, not generated: drizzle-kit models neither privileges nor
-- definer functions (same as 0009).
--
-- The planner's diversity note (ADR-038): the direction and the home page's
-- hero and services variants that other businesses in one industry were
-- planned with, one row per org, newest 20. The second read across tenants
-- after `list_org_ids`, and as narrow: three ids from a public library, no org
-- id, no name, no text a business wrote, and never the caller's own org. Same
-- defence as 0005, 0006 and 0009: `SET search_path = ''`, every relation
-- schema-qualified, and only `reme_app` may execute it.
-- shortcut: scans site_revisions with no time index; add one on
-- (created_at) when the table outgrows a sequential scan.
CREATE FUNCTION public.recent_designs(p_org uuid, p_industry text)
RETURNS TABLE (direction text, hero text, services text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select d.direction, d.hero, d.services
  from (
    select distinct on (r.org_id)
      r.created_at,
      a.blueprint->>'direction' as direction,
      jsonb_path_query_first(a.blueprint, '$.pages[*] ? (@.page == "home").sections[*] ? (@.kind == "hero").variant') #>> '{}' as hero,
      jsonb_path_query_first(a.blueprint, '$.pages[*] ? (@.page == "home").sections[*] ? (@.kind == "service_cards").variant') #>> '{}' as services
    from public.site_revisions r
    join public.assignments a on a.id = r.assignment_id and a.org_id = r.org_id
    join public.facts f
      on f.org_id = r.org_id and f.key = 'business.industry' and f.valid_to is null
    where r.version is not null
      and a.blueprint is not null
      and r.org_id <> p_org
      and f.value->>'category' = p_industry
    order by r.org_id, r.created_at desc
  ) d
  order by d.created_at desc
  limit 20
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.recent_designs(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.recent_designs(uuid, text) TO reme_app;
