import { PgDialect } from "drizzle-orm/pg-core"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { connect, loadLocalEnv } from "../src/client.ts"
import { ENTER_APP_ROLE, ORG_SETTING, setOrgContext } from "../src/tenancy.ts"

/**
 * Why `withOrg` sets the org context with `set_config(..., true)` and not
 * `false`, measured rather than asserted.
 *
 * Neon's pooler is PgBouncer in transaction mode: a client is handed whichever
 * backend is free for the length of one transaction, and the next transaction
 * may land somewhere else. A session-scoped GUC is therefore set on a backend
 * the next statement may never see again, and reads back on a backend some
 * other tenant set. A lone client never notices, because with no contention it
 * is handed the same backend every time, which is exactly what makes this the
 * kind of bug that ships.
 *
 * The run is real, not simulated: `CLIENTS` connections, each pinned to one
 * pooled client slot, each reading its own org, all at once. The transaction
 * arm issues the statements `withOrg` itself issues, rendered out of the same
 * builders, so this measures the shipped code rather than a copy of it. The
 * session arm is the counterfactual, and the only difference between them is
 * the third argument to `set_config`.
 *
 * Skipped without `DATABASE_URL_POOLED`, which the CI Postgres service does not
 * have. `rls.test.ts` carries the assertion that runs everywhere: the org
 * context must not survive its transaction. This file is the evidence for why
 * that assertion is there.
 */

loadLocalEnv()
const POOLED = process.env.DATABASE_URL_POOLED
const CLIENTS = 12
const ROUNDS = 20

/**
 * Fresh org ids on every run, and this is not cosmetic. A session-scoped
 * `set_config` is never cleared from a pooled backend: PgBouncer in transaction
 * mode leaves `server_reset_query_always` off, so the value sits there for the
 * life of the backend and is handed to every later client, across connections
 * and across runs. Measured 2026-08-27: the residue probe below read a stale
 * org id from an earlier run of this file, minutes later, on connections that
 * had never set anything. Fixed ids would make that indistinguishable from a
 * leak this run caused. These ids are deleted in `afterAll`, so a stale context
 * from a previous run now points at an org that no longer exists and reads
 * nothing.
 */
const RUN = Math.floor(Math.random() * 0xffff)
  .toString(16)
  .padStart(4, "0")

const orgs = Array.from(
  { length: CLIENTS },
  (_, i) => `00000000-0000-4000-8000-${RUN}${String(i).padStart(8, "0")}`
)

type Tally = {
  /** Reads that returned exactly the caller's own org. */
  correct: number
  /** Reads that returned nothing, which is denial rather than leakage. */
  empty: number
  /** Reads that returned somebody else's row. The one that must be zero. */
  otherTenant: number
  /**
   * Rows still visible in a later transaction that set no org context at all.
   * Anything above zero means a context outlived its transaction and is sitting
   * on a backend waiting for whoever is handed it next.
   */
  residue: number
}

const dialect = new PgDialect()
const ENTER = dialect.sqlToQuery(ENTER_APP_ROLE).sql

async function measure(mode: "session" | "transaction"): Promise<Tally> {
  const tally: Tally = { correct: 0, empty: 0, otherTenant: 0, residue: 0 }
  // One connection each, so twelve distinct clients queue for the pool rather
  // than one client multiplexing, which is what a fleet of Workers looks like.
  const clients = orgs.map(() =>
    postgres(POOLED as string, { max: 1, prepare: false })
  )
  try {
    await Promise.all(
      clients.map(async (client, i) => {
        const mine = orgs[i] as string
        const local = dialect.sqlToQuery(setOrgContext(mine))
        for (let round = 0; round < ROUNDS; round++) {
          let rows: { id: string }[]
          if (mode === "session") {
            await client`select set_config(${ORG_SETTING}, ${mine}, false)`
            rows = await client.begin(async (tx) => {
              await tx.unsafe(ENTER)
              return tx<{ id: string }[]>`select id from orgs`
            })
          } else {
            rows = await client.begin(async (tx) => {
              await tx.unsafe(ENTER)
              await tx.unsafe(local.sql, local.params as string[])
              return tx<{ id: string }[]>`select id from orgs`
            })
          }
          if (rows.length === 0) tally.empty++
          else if (rows.length === 1 && rows[0]?.id === mine) tally.correct++
          else tally.otherTenant++

          // The second half of the leak, and the half that survives a retry: a
          // transaction that sets no context reads whatever the last one left
          // on this backend. With `is_local = true` there is nothing to find.
          const leftover = await client.begin(async (tx) => {
            await tx.unsafe(ENTER)
            return tx<{ id: string }[]>`select id from orgs`
          })
          tally.residue += leftover.length
        }
      })
    )
  } finally {
    await Promise.all(clients.map((client) => client.end()))
  }
  return tally
}

async function seed() {
  const { sql } = connect()
  for (const [i, id] of orgs.entries()) {
    await sql`
      insert into orgs (id, slug, name)
      values (${id}, ${`tenancy-pool-${i}`}, ${`Tenancy Pool ${i}`})
      on conflict (id) do nothing`
  }
  await sql.end()
}

async function clear() {
  const { sql } = connect()
  await sql`delete from orgs where id = any(${orgs})`
  await sql.end()
}

describe.skipIf(!POOLED)("through a transaction pooler", () => {
  afterAll(clear)

  it("holds the org context transaction-locally and loses it session-scoped", async () => {
    await seed()
    // Order is load-bearing, and finding that out cost an afternoon. PgBouncer
    // in transaction mode does not reset a server between clients by default
    // (`server_reset_query_always` is off), so a session-scoped GUC sticks to a
    // backend and is handed to whoever gets it next, across connections and for
    // as long as the backend lives. Run the session arm first and it poisons
    // every backend in the pool, after which the transaction arm reads a
    // context it never set and appears to leak. It is not leaking. The session
    // arm goes last.
    const transaction = await measure("transaction")
    const session = await measure("session")
    const reads = CLIENTS * ROUNDS

    console.log("session-scoped set_config:", session)
    console.log("transaction-local set_config:", transaction)

    expect(transaction.correct, "transaction-local lost a read").toBe(reads)
    expect(transaction.otherTenant, "transaction-local leaked a row").toBe(0)
    expect(
      transaction.residue,
      "an org context outlived its transaction and is sitting on a pooled " +
        "backend, waiting for whoever is handed it next"
    ).toBe(0)
    // Measured 2026-08-27 on Neon, twelve clients and twenty rounds each,
    // three runs: 220, 226 and 228 of 240 session-scoped reads returned
    // another tenant's row, and all 240 residue probes found a context nobody
    // had set. Not a flake to tolerate. If these ever pass, the measurement
    // this file records has stopped being true and is worth re-taking before
    // anyone trusts the implementation it justifies.
    expect(
      session.otherTenant + session.empty,
      "session-scoped set_config held under contention, which contradicts " +
        "the measurement this file exists to record"
    ).toBeGreaterThan(0)
    expect(
      session.residue,
      "session-scoped set_config left nothing behind, " +
        "which contradicts the measurement this file exists to record"
    ).toBeGreaterThan(0)
  }, 180_000)
})
