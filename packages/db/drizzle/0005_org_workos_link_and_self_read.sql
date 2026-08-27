ALTER TABLE "orgs" ADD COLUMN "workos_organization_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_workos_organization_key" UNIQUE("workos_organization_id");--> statement-breakpoint
CREATE POLICY "users_self_read" ON "users" AS PERMISSIVE FOR SELECT TO public USING (workos_user_id = nullif(current_setting('app.workos_user_id', true), ''));--> statement-breakpoint
-- Everything below is custom SQL appended to the generated migration, because
-- drizzle-kit models neither functions nor privileges. It is ADR-029's
-- resolver, verbatim.
--
-- It answers the one question the API cannot answer for itself: which `org_id`
-- does this request run under. Every other read happens inside `withOrg`, which
-- needs that id before it can open a transaction, so the lookup runs before any
-- org context exists. Under RLS that read is denied, and denied is correct:
-- `orgs` shows the current org and nothing else, and the current org is what we
-- are trying to find out.
--
-- SECURITY DEFINER is how it gets out of that, and it is why the body below is
-- the whole security boundary. The function runs as its owner, which on Neon is
-- `neondb_owner` with `rolbypassrls = true`, so no policy is evaluated inside
-- it and there is no second control behind it.
--
-- `SET search_path = ''`, with every relation schema-qualified, is the whole of
-- the privilege escalation defence. A definer function that resolves `orgs`
-- through a mutable search path runs whatever table the caller put in front of
-- it, as the owner, with BYPASSRLS.
--
-- `STRICT` refuses a null argument before the body runs. Every other refusal is
-- a null result rather than an error, because a caller that could tell "no such
-- membership" from "no such org" would learn which organizations exist.
CREATE FUNCTION public.resolve_org(
  p_workos_user_id text,
  p_workos_organization_id text
) RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
  select o.id
  from public.orgs o
  join public.memberships m on m.org_id = o.id
  join public.users u on u.id = m.user_id
  where o.workos_organization_id = p_workos_organization_id
    and u.workos_user_id = p_workos_user_id
    and m.status = 'active'
$$;
--> statement-breakpoint
-- Not decoration. A fresh function has a null `proacl`, which means the
-- default, and the default for a function is EXECUTE to PUBLIC. Written without
-- this line, a full cross-tenant read would be callable by anything holding a
-- connection.
REVOKE ALL ON FUNCTION public.resolve_org(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_org(text, text) TO reme_app;
