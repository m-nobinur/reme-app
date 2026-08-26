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
`reme_app` role, sets `app.org_id`, and hands the callback a handle. Nothing else on the
package surface returns a handle, so a raw query outside `withOrg` has nothing to run on and
does not typecheck; `test/surface.types.ts` fails `pnpm typecheck` if `connect` is ever
re-exported.

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
is what lets them write the platform-level rows the policies deny to tenants. When a
per-environment credential arrives with Hyperdrive, point it at `reme_app` and the
`SET LOCAL ROLE` becomes belt over braces rather than the only strap.

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
table names, so it covers tables that do not exist yet. Per discovered tenant table it asserts
RLS is enabled, that every policy reads `app.org_id`, that every policy which can write has a
`WITH CHECK`, that org A sees none of org B's rows, that a write aimed at org B touches
nothing, that moving one of A's own rows to B is refused, and that a nullable `org_id` cannot
be nulled by a tenant. With no org context set, every tenant table reads zero rows.

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

### Not done yet

Cross-org denial **through the authenticated API** is the other half of this gate and cannot
be built until there are authenticated endpoints (B5, D3). The hook is `withOrg`: the same
suite gains an API arm once `apps/api` resolves a tenant context, and D4 is where it lands.
