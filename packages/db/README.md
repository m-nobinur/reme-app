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
- `fixtures/` is the golden orgs, described below.

```sh
pnpm db:generate --name what_it_does   # schema edit -> SQL, always with a name
pnpm db:migrate                        # apply what is pending
pnpm db:check                          # collisions between migration files
pnpm seed                              # the golden orgs, --reset to start clean
pnpm test:seed                         # the seed round trip, needs a database
pnpm test:tenancy                      # the blocking tenancy gate
```

## The golden orgs

`fixtures/golden.ts` is `brightclean`, `mopandbucket` and `emptyco`: one set of rows shared by
the seed, the suites, the mock UI and the evals, so nobody writes a second copy of the same
business. `brightclean` is fully configured and carries the §5.2 staff tree, `mopandbucket` is
a smaller second tenant to be denied against, and `emptyco` is an owner who has configured
nothing, which is the state every empty screen has to handle.

The module is data only. Every import in it is `import type`, so it has no runtime dependency
on drizzle or on a connection and `@workspace/db/fixtures` can be imported from a Worker
bundle. `@workspace/db/fixtures/seed` is the writer and is Node-only.

R8 says a fixture business must be unmistakably fictional, and `test/golden-fixtures.test.ts`
enforces it rather than trusting a comment: every address is under `.invalid`, which RFC 2606
reserves so it can never resolve; every phone number is in the North American `555-01xx` range;
and every org name carries `(fixture)`. That test ships with a negative fixture, because a
check nobody has watched fail is not a check.

`pnpm seed` inserts what is missing and leaves everything else alone, so it is safe on a
database holding other data. `pnpm seed --reset` clears the three orgs first, which is how a
database is brought back in line with the file. Both are one transaction under an advisory
lock: two concurrent runs queue rather than interleave, and without the lock one of the two
fails on a foreign key every time.

The seed writes as the migrator rather than through `withOrg`, and `fixtures/seed.ts` says why
at length. The short version: `--reset` deletes append-only rows the app role is deliberately
not granted, and the clear has to span three orgs in one transaction while `withOrg` scopes to
one. `fixtures/seed.test.ts` is what proves the seeded rows are readable through the policies
and not only through the role that wrote them.

Two things it does not handle. A fixture whose content changed is not updated by a plain
`pnpm seed`; that is what `--reset` is for. And two suite runs sharing one database, where one
resets while the other asserts, will collide: fixed ids are the point of a golden fixture, so
no id scheme avoids it, and the model is one database per runner.

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
`reme_app` role, sets `app.org_id` and `app.workos_user_id`, hands the callback a handle, and
takes the handle back when the callback settles.

Both settings go out in one statement, and both are transaction-local. The second one is what
the two `users` write policies key on: `users` is a platform table, so a person signing up has
to write their own row before any membership can vouch for it, and the policy asks who is
signing in rather than where they work. `ctx.workosUserId` is optional; leaving it out sets
the empty string, which reads as NULL and matches no row, so those two policies deny.

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
`tenancy/rls.test.ts`. Adding a name to it is the decision to put data outside the tenant
boundary, and it needs a reviewer who agrees rather than a passing build.

The name is not an exemption. An entry there is a name plus the read that proves the table is
still confined, so it cannot be added on its own, and a platform table still has to have RLS
enabled, still has to carry at least one policy whose `USING` names `app.org_id`, and still
has to show org A its own row and org B none of it through `withOrg`. `users` is the only
entry (ADR-028): a person is one row however many orgs they work in, because that is the grain
WorkOS keeps them at, and `memberships` carries the org.

The gate has a second half outside this package. `pnpm test:tenancy` runs `apps/api/tenancy/`
after this directory, where the same denial is driven through the authenticated API: a real
HTTP request carrying a real sealed session cookie, answered by the routes an owner's browser
reaches. Everything here and in `withOrg` stops one line below where an org id is decided, so
neither can see a handler that read `?org_id=` and passed it on. It lives in `apps/api` because
the dependency direction only goes one way, and it runs from here because a gate assembled out
of two commands is one command away from being half a gate.

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

**A script that uses `withOrg` does not exit.** `withOrg` opens one pool lazily, shares it and
exports no way to close it, so a Node process that reads through it never exits. Measured
2026-08-28 against the local container: a script whose only statement was `select 1` returned
from the callback in 34 ms and was killed by a 25 s timeout at exit 124, and its
`process.on("exit")` handler never fired. Vitest never sees it, because it tears its workers
down, which is why the tenancy suite never caught it. A script builds `tenancy(url)` and
closes it.

That is one of the two shapes the kit has. The other is `tenancy(url)`, a kit over a pool the
caller owns, which is what a Worker uses: Hyperdrive hands its connection string to the request
rather than to the environment, and each isolate wants its own pool.

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
