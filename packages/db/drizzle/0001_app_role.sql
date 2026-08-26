-- The role every tenant read and write runs as.
--
-- Custom SQL, not generated: drizzle-kit does not model roles, and this has to
-- exist before any policy is worth writing. Neon's `neondb_owner` has
-- `rolbypassrls = true` (measured 2026-08-27 on project
-- sparkling-wildflower-04343187), so a policy checked against the connecting
-- role would never be evaluated at all. `FORCE ROW LEVEL SECURITY` does not
-- help: it closes the table-owner hole, not the BYPASSRLS one.
--
-- NOLOGIN on purpose. Nothing connects as `reme_app`; `withOrg` reaches it with
-- `SET LOCAL ROLE` inside the reading transaction, so the role is scoped to the
-- transaction exactly as the org context is. Migrations keep running as the
-- owner, which is what lets them seed platform-level rows the policies below
-- deny to tenants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reme_app') THEN
    CREATE ROLE reme_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- CURRENT_USER rather than a literal: the migrator is `neondb_owner` on Neon
-- and `reme` on the CI service container.
GRANT reme_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO reme_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reme_app;
--> statement-breakpoint
-- Tables added by later migrations are granted on creation. A table that
-- arrives without a policy is therefore readable by `reme_app`, which is what
-- the tenancy suite exists to catch: it enumerates the catalog and fails, in
-- CI, before the table can reach an environment.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reme_app;
