# @workspace/db

The Drizzle schema, the migrations, and the scripts that apply them. Postgres is the only
system of record in the product, so this package is where a mistake is most expensive and
hardest to take back.

- `src/schema.ts` is the schema and the policies. One file, because reading the whole tenant
  boundary in one pass is worth more than short files.
- `src/tenancy.ts` is `withOrg`, the only way to a database handle.
- `tenancy/` is the blocking suite, run by `pnpm test:tenancy`.
- `src/map.ts` maps rows onto the `packages/contracts` shapes that describe the same thing.
- `drizzle/` is generated SQL. Committed, reviewed, never hand-edited after it has been applied.
- `scripts/migrate.ts` applies pending migrations under a lock.
- `scripts/probe-seed.ts` writes one row per table so a migration can be tried against a
  database that is not empty. It is a probe, not the fixture set: the golden orgs come later.

```sh
pnpm db:generate --name what_it_does   # schema edit -> SQL, always with a name
pnpm db:migrate                        # apply what is pending
pnpm db:check                          # collisions between migration files
pnpm --filter @workspace/db seed:probe # one row per table
pnpm test:tenancy                      # the blocking tenancy gate
```

## Writing a migration

Every migration is expand/contract. This is not a style preference: a deploy is gradual, so
old and new code run against the same database at the same time, and a rollback is
`wrangler rollback` with the schema left where it is.

**Expand, in the release that adds the code.**

- New columns are nullable, or they have a default. A `NOT NULL` column with no default
  breaks every running instance of the old code the moment it lands.
- New tables and new indexes are additive and safe.
- Renaming a column is two releases: add the new one, write both, then stop reading the old
  one. Drizzle will happily generate `ALTER TABLE ... RENAME`, which is a break dressed up as
  one statement. Do not take it.
- `CREATE INDEX CONCURRENTLY` for a table with rows in it, and it cannot run inside a
  transaction, so it goes in a migration file of its own.

**Contract, a release later.**

- A `DROP COLUMN` or `DROP TABLE` ships only after the release that stopped reading it is
  live and is not going to be rolled back.
- Backfills run in batches, outside the migration, and never hold a lock across the whole
  table.

Read the generated SQL before you commit it. drizzle-kit writes what it infers from a
snapshot diff, and the inference is only as good as the edit: it cannot tell a rename from a
drop plus an add, and it does not always carry an escape through into the file. The first
migration here shipped with `\.` in a check constraint that arrived as `.`, which matches any
character, so a regex that was supposed to require a dotted event type accepted anything.

## The lock

`pnpm db:migrate` takes a session-scoped advisory lock on a fixed id before its first
statement and releases it after its last. Two runs against one database queue instead of
interleaving DDL, and the one that waits wakes up to find nothing pending. Without it, two
concurrent runs race on `CREATE SCHEMA` and one of them fails partway through.

The lock is also why migrations refuse a pooled connection, and the script exits rather than
guessing. Neon's pooler is PgBouncer in transaction mode, and
[its documentation](https://neon.com/docs/connect/connection-pooling) lists session-level
advisory locks among the things it does not support: the lock is taken on whichever backend
served that statement, and the next transaction may land on a different one. It does not
error, it silently stops locking. Migrations use the direct endpoint, which is
`neonctl connection-string <branch>` without `--pooled`.

The same restriction is about to matter for tenancy. Setting the RLS context with a
session-scoped `set_config('app.org_id', ..., false)` looks fine on a quiet connection and
leaks a tenant boundary on a busy one. It has to be transaction-scoped, set inside the
transaction that reads.

## Tenancy

Reads and writes go through `withOrg(ctx, fn)`. It opens one transaction, switches to the
`reme_app` role, sets `app.org_id`, hands the callback a handle, and takes the handle back
when the callback settles.

Two separate guarantees, and it is worth being exact about which is which.

*Reaching* a handle outside `withOrg` does not typecheck: nothing else on the package surface
returns one, so there is no exported value to call `.select()` on, and `test/surface.types.ts`
fails `pnpm typecheck` if `connect` is ever re-exported.

*Keeping* one is a runtime guarantee, not a type one. `withOrg` returns whatever the callback
returns and the callback's parameter is the handle, so `async (db) => db` compiles, and so do
the ordinary shapes around it: `async (db) => ({ db, rows })`, a helper that returns the
transaction for its caller to finish with, a handler that memoises. The brand on `OrgScopedDb`
constrains the type, not the connection. So the handle is wrapped, and the wrapper is revoked
in a `finally` inside the transaction: any use after that throws, whether the callback
returned, threw, or hid the handle inside something else. Returning it bare does not even get
that far, because an async function resolving its own promise reads `.then` off the returned
object, so `withOrg` rejects and the transaction rolls back.

This matters more than it sounds. An escaped handle does not come back degraded, it comes back
**promoted**: the transaction is over, so the pooled connection carries no `SET LOCAL ROLE` and
no `app.org_id`, and the next statement runs as the connecting role. Measured 2026-08-27
against the `tenancy-rls` branch, an escaped handle reported `current_user = neondb_owner` with
an empty org context and read every row of both probe orgs, with no error and nothing in the
log. `tenancy/rls.test.ts` covers all three escape shapes.

```ts
import { withOrg } from "@workspace/db"

const rows = await withOrg({ orgId }, (db) => db.select().from(staff))
```

`org_id` is resolved server-side from identity and never read from a request body. `withOrg`
rejects anything that is not a uuid before it reaches a statement.

### Three things that are easy to get wrong here

**The role.** Neon's `neondb_owner` has `rolbypassrls = true`, measured 2026-08-27. A policy
is not a boundary for a role that bypasses it, and `FORCE ROW LEVEL SECURITY` does not rescue
it: FORCE closes the table-owner hole, not the BYPASSRLS one. So migration `0001_app_role`
creates `reme_app`, which is `NOLOGIN NOBYPASSRLS`, and `withOrg` reaches it with
`SET LOCAL ROLE` inside the reading transaction. Migrations keep running as the owner, which
is what lets them write the platform-level rows the policies deny to tenants.

`SET LOCAL ROLE` is the only strap today, and it is one the callback can undo: inside
`withOrg`, `reset role`, `set local role neondb_owner` and re-setting `app.org_id` to another
org all work and all typecheck. The fix is to connect as a login role that lacks BYPASSRLS, at
which point the switch is belt over braces. That role does not exist yet, and cannot be
created here: `reme_app` is `NOLOGIN` with no password, and inventing one in a migration is
not the way to get it. It arrives with the per-environment Hyperdrive credential, which is a
later story. See "Known gaps".

**The scope.** `set_config('app.org_id', ..., true)`. The third argument is `is_local` and it
is not a detail. Measured 2026-08-27 through the Neon pooler with twelve concurrent clients:
transaction-local returned the caller's own row on 240 of 240 reads and left nothing behind,
while the session-scoped form returned **another tenant's row on 220 to 228 of those 240** and
left a live org context on every backend it touched, where the next client to be handed that
backend reads it. PgBouncer in transaction mode does not reset a server between clients, so
that context sits there for the life of the backend. A lone client reads its own value back
either way, which is exactly why the wrong version passes every quiet test.

**The nullable column.** `roles.org_id` is nullable by design: NULL means a platform-defined
template (§5.3). Its read policy is therefore `org_id IS NULL OR org_id = ...`, which is
lenient, so it is split in two. `roles_org_read` is `FOR SELECT` and lenient; `roles_org_write`
is `FOR ALL` with plain equality in both `USING` and `WITH CHECK`. A single lenient `FOR ALL`
policy would let a tenant delete a platform template, because DELETE is checked against
`USING` and has no `WITH CHECK` to stop it. `roles` is the only nullable `org_id` in the
schema today; the suite discovers that from the catalog rather than trusting this sentence.

### The suite

`pnpm test:tenancy` reads `pg_class`, `pg_attribute` and `pg_policies` instead of a list of
table names, so it covers relations that do not exist yet. It discovers every relation kind
the grants reach, which is `relkind in ('r','p','v','m','f')` and not only `'r'`:
`ALTER DEFAULT PRIVILEGES ... ON TABLES` is `defaclobjtype 'r'`, and in Postgres that means
relations, so a view created with no `GRANT` written anywhere is granted to `reme_app` on
creation. A view runs as its owner unless it says otherwise, and the owner holds BYPASSRLS, so
the first reporting view anyone writes is a full-tenant read.

Per discovered tenant table it asserts RLS is enabled, that every policy reads `app.org_id`,
that every policy which can write has a `WITH CHECK`, that org A sees none of org B's rows,
that a write aimed at org B touches nothing, that moving one of A's own rows to B is refused,
and that a nullable `org_id` cannot be nulled by a tenant. With no org context set, every
tenant table reads zero rows. A partitioned parent is discovered as a table and has to carry
RLS in its own right, because RLS on the partitions does not close the parent.

Per discovered view, materialised view or foreign table it asserts one of two things: that
`reme_app` cannot read it, or that it is a view with `security_invoker = on`, in which case
the base tables' policies apply. A materialised view or a foreign table has no invoker option,
so revoking is the only answer for those.

`events` and `staff_events` are append-only, so the suite asserts UPDATE and DELETE are
refused on both rather than merely scoped to the caller's org. Migration `0003` revokes the
grants that said otherwise.

Two fixtures build the failure and the near miss inside the test and drop both: a view with no
`security_invoker` that must be caught, next to one with it that must not, each read through
`withOrg` to show the leak rather than only its catalog shape; and a table with a `serial`
column, inserted into as `reme_app`, which fails with `42501 permission denied for sequence`
without the sequence grants migration `0003` adds. Anything left behind by a killed run is
dropped before discovery reads the catalog.

Adding a table means adding its rows to `tenancy/fixtures.ts`. Denial proven against an empty
table proves nothing, so the suite fails a tenant table with no fixture row and says so.

A public table with no `org_id` fails too, unless it is named in `PLATFORM_TABLES` in
`tenancy/rls.test.ts`. That list is empty. Adding a name to it is the decision to put data
outside the tenant boundary, and it needs a reviewer who agrees rather than a passing build.

`tenancy/pooler.test.ts` is the measurement behind the second point above. It needs
`DATABASE_URL_POOLED` and skips without one, which is what it does in CI: the service
container there has no pooler in front of it. The assertion that runs everywhere is in
`tenancy/rls.test.ts`, and it checks the statements `withOrg` issues are the `LOCAL` forms. On
a direct connection there is no behaviour to observe, because a session setting and a
transaction setting read back identically when nothing is reassigning backends underneath.

### Known gaps

Named rather than implied, because each of them is a thing this package's guarantees do not
cover today.

**The app connects as an owner.** `withOrg` switches to `reme_app` with `SET LOCAL ROLE`, and
the callback can switch back: `reset role` inside the callback restores `neondb_owner`, which
holds BYPASSRLS. Closing it needs a login role that lacks BYPASSRLS, and `reme_app` is
`NOLOGIN` with no password. Provisioning that credential belongs with the per-environment
Hyperdrive configuration.

**CI proves this against a lookalike.** The `database` job runs against a
`pgvector/pgvector:pg17` service container whose `reme` user is a superuser. The whole design
rests on a Neon-specific fact, that `neondb_owner` holds `rolbypassrls`, and CI never
exercises it: it happens to hold there too, for a different reason. The measurement is in
`tenancy/pooler.test.ts`, which needs `DATABASE_URL_POOLED` and skips in CI, and against the
`tenancy-rls` Neon branch by hand. Treat a green CI run as the schema-shape half of the gate.

**The gate is only as blocking as the workflow file.** "Not removable" means one `run:` line
in `.github/workflows/ci.yml` that any PR can delete. Branch protection, which is what would
make it binding, needs a paid plan on a private repo and is off.

**Cross-org denial through the authenticated API** is the other half of this gate and cannot
be built until there are authenticated endpoints. The hook is `withOrg`: the same suite gains
an API arm once `apps/api` resolves a tenant context.
