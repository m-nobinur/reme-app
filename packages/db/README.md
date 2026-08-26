# @workspace/db

The Drizzle schema, the migrations, and the scripts that apply them. Postgres is the only
system of record in the product, so this package is where a mistake is most expensive and
hardest to take back.

- `src/schema.ts` is the schema. One file, because reading the whole tenant boundary in one
  pass is worth more than short files.
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

There are no RLS policies here yet, and that is the next story rather than an oversight. The
columns are already shaped for them:

- Every tenant-scoped table has `org_id`. `orgs` is the tenant root and scopes on `id`.
  `roles` allows a NULL `org_id`, which means a platform-defined template, so its policy is
  the one that needs `org_id IS NULL OR org_id = ...`.
- `org_id` travels inside every foreign key that stays inside the tenant boundary, so a staff
  member cannot report to a manager in another org and a fact cannot supersede one belonging
  to someone else. RLS does not catch that class of bug; the foreign key does.

Two constraints in §5.2 are only half built. `staff_one_root_per_org` gives exactly one root
per org, and the column being scalar gives single-parent, but nothing yet rejects a cycle in
the reporting line. That needs a constraint trigger with a recursive CTE, and it lands with
the first endpoint that can write a reporting line rather than sitting here untested.
