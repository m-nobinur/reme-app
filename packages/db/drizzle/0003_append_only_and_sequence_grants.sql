-- Two grants from 0001 that did not match what the schema says.
--
-- Custom SQL, not generated: drizzle-kit does not model roles or privileges.

-- `events` (§10.1 store 6, R7) and `staff_events` (§5.2) are append-only. The
-- schema says so in prose and neither carries an `updated_at`, but `reme_app`
-- held UPDATE and DELETE on both, so a tenant could rewrite or erase its own
-- audit trail. RLS scoped that to the caller's own org, which makes it a
-- contradiction of the stated design rather than a cross-tenant hole, and
-- nothing asserted otherwise. `tenancy/rls.test.ts` now does.
REVOKE UPDATE, DELETE ON "events", "staff_events" FROM reme_app;
--> statement-breakpoint
-- 0001 granted tables and, through `ALTER DEFAULT PRIVILEGES ... ON TABLES`,
-- every table added later. It granted no sequences and set no default for them,
-- so the first `serial` column would have failed at runtime rather than in the
-- gate: `insert into ticket ...` raises `42501 permission denied for sequence
-- ticket_id_seq` while every catalog assertion stays green. Measured against
-- the `tenancy-rls` branch 2026-08-27.
--
-- USAGE is what `nextval` needs; SELECT is what `currval` and a `lastval` read
-- need. No UPDATE: that is `setval`, which resets a sequence, and nothing the
-- app role does should.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reme_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO reme_app;
