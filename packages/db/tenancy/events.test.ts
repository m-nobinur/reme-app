import { sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { appendSessionEvent } from "../src/events.ts"
import { orgs } from "../src/schema.ts"
import { pgCode, withOrg } from "../src/tenancy.ts"

/**
 * `appendSessionEvent` against Postgres, under `withOrg`: the seq it
 * allocates, and the unique index refusing a second writer (ADR-034).
 */
const ORG = crypto.randomUUID()
const ctx = { orgId: ORG }

const append = (sessionId: string, type = "cos.message") => ({
  orgId: ORG,
  assignmentId: null,
  staffId: null,
  sessionId,
  type,
  payload: {},
})

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, [ORG], []))
  } finally {
    await client.end()
  }
})

describe("a session's event stream", () => {
  it("allocates the next seq in one transaction and across two, per session", async () => {
    const session = crypto.randomUUID()
    const other = crypto.randomUUID()
    const first = await withOrg(ctx, async (db) => {
      await db.insert(orgs).values({
        id: ORG,
        slug: `events-probe-${ORG.slice(0, 8)}`,
        name: "Events probe (fixture)",
      })
      return [
        await appendSessionEvent(db, append(session, "cos.context")),
        await appendSessionEvent(db, append(session)),
      ]
    })
    const later = await withOrg(ctx, async (db) => [
      await appendSessionEvent(db, append(session)),
      await appendSessionEvent(db, append(other)),
    ])
    expect([...first, ...later].map((row) => row.seq)).toEqual([0, 1, 2, 0])
  })

  it("refuses a second writer that read the same last seq", async () => {
    const session = crypto.randomUUID()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let appended!: () => void
    const firstIn = new Promise<void>((resolve) => {
      appended = resolve
    })
    const first = withOrg(ctx, async (db) => {
      await appendSessionEvent(db, append(session))
      appended()
      await held
    })
    await firstIn
    const second = withOrg(ctx, (db) =>
      appendSessionEvent(db, append(session))
    ).then(
      () => null,
      (error: unknown) => pgCode(error)
    )

    // The second insert reads seq 0 free and then waits on the first's
    // uncommitted row in the index. Commit the first once it waits, or after
    // two seconds, when the second has had time to finish without waiting.
    const { sql: client, db: watcher } = connect()
    try {
      for (let tries = 0, waiting = 0; tries < 100 && !waiting; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const [row] = await watcher.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where wait_event = 'transactionid' and query ilike 'insert into "events"%'`)
        waiting = row?.n ?? 0
      }
    } finally {
      await client.end()
    }
    release()
    await first
    expect(await second).toBe("23505")
  })
})
