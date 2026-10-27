-- Custom SQL, not generated (same as 0015).
--
-- The custom-hostname alert's way from a hostname to the claim that is
-- waiting on its certificate. `resolve_domain_host` answers active rows only,
-- and the claim to nudge is still connecting. It runs before any org context
-- exists, so RLS cannot scope it, and the body is the boundary: a claim that
-- is connecting or live, matched on the name or its `www.`, and two columns
-- back (no cf_ids, approval, provider or check). Same defence as 0015:
-- `SET search_path = ''`, schema-qualified, STRICT, only `reme_app` may
-- execute it, and no row for a host nothing holds rather than an error.
CREATE FUNCTION public.resolve_domain_claim(p_host text)
RETURNS TABLE (org_id uuid, name text)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select d.org_id, d.name
  from public.domains d
  where d.state in ('awaiting_dns', 'verifying', 'active')
    and d.name in (lower(p_host), regexp_replace(lower(p_host), '^www\.', ''))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_domain_claim(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_domain_claim(text) TO reme_app;
