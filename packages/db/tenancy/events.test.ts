import { sql } from "drizzle-orm"
import { ulid } from "ulid"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { appendEvent, appendSessionEvent } from "../src/events.ts"
import { events, orgs } from "../src/schema.ts"
import { pgCode, withOrg } from "../src/tenancy.ts"

/**
 * The event appenders against Postgres, under `withOrg`: the seq
 * `appendSessionEvent` allocates, the unique indexes refusing a second writer
 * and a retried key (ADR-034), and `event_id` as the append order.
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

beforeAll(() =>
  withOrg(ctx, (db) =>
    db.insert(orgs).values({
      id: ORG,
      slug: `events-probe-${ORG.slice(0, 8)}`,
      name: "Events probe (fixture)",
    })
  )
)

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
    const first = await withOrg(ctx, async (db) => [
      await appendSessionEvent(db, append(session, "cos.context")),
      await appendSessionEvent(db, append(session)),
    ])
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
    let pidOf!: (pid: number) => void
    const secondPid = new Promise<number>((resolve) => {
      pidOf = resolve
    })
    const second = withOrg(ctx, async (db) => {
      const [own] = await db.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`
      )
      pidOf(Number(own?.pid))
      return appendSessionEvent(db, append(session))
    }).then(
      () => null,
      (error: unknown) => pgCode(error)
    )

    // The second insert reads seq 0 free and then waits on the first's
    // uncommitted row in the index. Commit the first once it waits, or after
    // two seconds, when the second has had time to finish without waiting.
    const pid = await secondPid
    const { sql: client, db: watcher } = connect()
    try {
      for (let tries = 0, waiting = 0; tries < 100 && !waiting; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const [row] = await watcher.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where pid = ${pid} and wait_event = 'transactionid'`)
        waiting = row?.n ?? 0
      }
    } finally {
      await client.end()
    }
    release()
    await first
    expect(await second).toBe("23505")
  })

  it("refuses a retried idempotency key and writes no second seq", async () => {
    const session = crypto.randomUUID()
    const retry = { ...append(session), idempotencyKey: ulid() }
    const once = await withOrg(ctx, (db) => appendSessionEvent(db, retry))
    const again = await withOrg(ctx, (db) =>
      appendSessionEvent(db, retry)
    ).then(
      () => null,
      (error: unknown) => pgCode(error)
    )
    const seqs = await withOrg(ctx, (db) =>
      db
        .select({ seq: events.seq })
        .from(events)
        .where(sql`${events.sessionId} = ${session}`)
    )
    expect([once.seq, again, seqs]).toEqual([0, "23505", [{ seq: 0 }]])
  })

  it("orders appends in one millisecond by event_id as they were written", async () => {
    // A Worker's clock stands still within a request; this one does too.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    const session = crypto.randomUUID()
    const written = Array.from({ length: 20 }, (_, i) => `probe.order_${i}`)
    try {
      await withOrg(ctx, async (db) => {
        for (const [i, type] of written.entries()) {
          if (i % 2) await appendEvent(db, { ...append(session), type })
          else await appendSessionEvent(db, append(session, type))
        }
      })
    } finally {
      vi.useRealTimers()
    }
    const read = await withOrg(ctx, (db) =>
      db
        .select({ type: events.type })
        .from(events)
        .where(sql`${events.type} like 'probe.order_%'`)
        .orderBy(events.eventId)
    )
    expect(read.map((row) => row.type)).toEqual(written)
  })
})
