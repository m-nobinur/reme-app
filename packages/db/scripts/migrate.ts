import { fileURLToPath } from "node:url"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { connect } from "../src/client.ts"

/**
 * Applies every pending migration, once, under a lock.
 *
 * The lock is a session-scoped Postgres advisory lock on a fixed id, taken
 * before the first statement and released after the last. Two migration runs
 * against the same database (a deploy racing a CI job, two CI jobs on one
 * branch) therefore queue instead of interleaving DDL; the second one wakes up
 * to find nothing pending and exits clean.
 *
 * That lock is why this refuses a pooled connection. Neon's pooler is PgBouncer
 * in transaction mode, and its docs list session-level advisory locks among the
 * features it does not support: the lock is taken on whichever backend served
 * that statement and the next transaction may land on a different one. It does
 * not error. It silently stops locking, so the failure only shows up as two
 * concurrent deploys corrupting a schema. Migrations use the direct endpoint.
 *
 * The check below is a hostname heuristic, not a guarantee: it knows Neon's
 * `-pooler` naming and nothing else, so a non-Neon PgBouncer or a Hyperdrive
 * binding passes straight through. There is no runtime probe that would do
 * better. A lone client through PgBouncer in transaction mode is handed the
 * same backend every time, so taking a session lock and reading it back
 * reports success on exactly the setup this is meant to catch.
 */
const LOCK_ID = 4027431100

const folder = fileURLToPath(new URL("../drizzle", import.meta.url))
const { sql, db } = connect()

const host = sql.options.host.join(",")
if (host.includes("-pooler")) {
  console.error(
    `refusing to migrate through the connection pooler (${host}).\n` +
      "Use the direct endpoint: `neonctl connection-string <branch>` without --pooled."
  )
  await sql.end()
  process.exit(1)
}

async function appliedCount() {
  const [registered] = await sql`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present`
  if (!registered?.present) return 0
  const [row] =
    await sql`select count(*)::int as n from drizzle.__drizzle_migrations`
  return row?.n ?? 0
}

await sql`select pg_advisory_lock(${LOCK_ID})`
try {
  const before = await appliedCount()
  await migrate(db, { migrationsFolder: folder })
  const after = await appliedCount()
  console.log(
    after === before
      ? `nothing to migrate, ${before} already applied`
      : `applied ${after - before} migration(s), ${after} total`
  )
} finally {
  await sql`select pg_advisory_unlock(${LOCK_ID})`
  await sql.end()
}
