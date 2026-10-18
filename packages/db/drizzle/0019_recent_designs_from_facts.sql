CREATE INDEX "facts_current_industry_idx" ON "facts" USING btree (("value"->>'category'),"org_id") WHERE key = 'business.industry' and valid_to is null;--> statement-breakpoint
CREATE INDEX "site_revisions_org_numbered_idx" ON "site_revisions" USING btree ("org_id","created_at") WHERE version is not null;--> statement-breakpoint
-- Custom SQL below, not generated (same as 0014). The same rows as 0014's
-- body, found the other way round: the industry's orgs from the facts index,
-- then each one's newest planned revision from the revisions index, so a call
-- reads one industry's sites rather than every tenant's. CREATE OR REPLACE
-- keeps the owner and the grants 0014 set.
CREATE OR REPLACE FUNCTION public.recent_designs(p_org uuid, p_industry text)
RETURNS TABLE (direction text, hero text, services text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select d.direction, d.hero, d.services
  from public.facts f
  cross join lateral (
    select
      r.created_at,
      a.blueprint->>'direction' as direction,
      jsonb_path_query_first(a.blueprint, '$.pages[*] ? (@.page == "home").sections[*] ? (@.kind == "hero").variant') #>> '{}' as hero,
      jsonb_path_query_first(a.blueprint, '$.pages[*] ? (@.page == "home").sections[*] ? (@.kind == "service_cards").variant') #>> '{}' as services
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
