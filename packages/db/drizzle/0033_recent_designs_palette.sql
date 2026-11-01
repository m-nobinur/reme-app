-- Custom SQL, not generated (same as 0014). 0019's rows with each plan's
-- palette preset id too, null for an owner's own colours, so the planner can
-- keep two businesses in one industry off the same palette. A new return type
-- cannot be made with CREATE OR REPLACE, so the grants are set again.
DROP FUNCTION public.recent_designs(uuid, text);
--> statement-breakpoint
CREATE FUNCTION public.recent_designs(p_org uuid, p_industry text)
RETURNS TABLE (direction text, hero text, services text, palette text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select d.direction, d.hero, d.services, d.palette
  from public.facts f
  cross join lateral (
    select
      r.created_at,
      a.blueprint->>'direction' as direction,
      jsonb_path_query_first(a.blueprint, '$.pages[*] ? (@.page == "home").sections[*] ? (@.kind == "hero").variant') #>> '{}' as hero,
      jsonb_path_query_first(a.blueprint, '$.pages[*] ? (@.page == "home").sections[*] ? (@.kind == "service_cards").variant') #>> '{}' as services,
      a.blueprint->'palette'->>'id' as palette
    from public.site_revisions r
    join public.assignments a on a.id = r.assignment_id and a.org_id = r.org_id
    where r.org_id = f.org_id
      and r.version is not null
      and a.blueprint is not null
    order by r.created_at desc
    limit 1
  ) d
  where f.key = 'business.industry'
    and f.valid_to is null
    and f.value->>'category' = p_industry
    and f.org_id <> p_org
  order by d.created_at desc
  limit 20
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.recent_designs(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.recent_designs(uuid, text) TO reme_app;
