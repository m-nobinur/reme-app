ALTER TABLE "domains" ADD COLUMN "ownership" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Custom SQL below, not generated (same as 0015).
--
-- The connect path's takeover guard. RLS hides another org's rows, removed
-- and failed ones included, so a claim cannot see that a name was held
-- before; a record that still points at us from that claim would let the new
-- one go live on DNS alone. This answers one boolean and nothing else:
-- whether an org other than the caller's ever held the name, in any state.
-- The caller's org is read from `app.org_id`, never from an argument, so it
-- runs inside the claim's own `withOrg`; with no context set every row counts
-- as another org's, which errs towards asking for the TXT. Same defence as
-- `resolve_domain_host`: `SET search_path = ''`, schema-qualified, STRICT,
-- and only `reme_app` may execute it.
CREATE FUNCTION public.domain_held_elsewhere(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select exists (
    select 1
    from public.domains d
    where d.name = lower(p_name)
      and d.org_id is distinct from
        nullif(current_setting('app.org_id', true), '')::uuid
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.domain_held_elsewhere(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.domain_held_elsewhere(text) TO reme_app;
