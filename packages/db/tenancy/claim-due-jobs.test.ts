import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect, connectionString } from "../src/client.ts"
import { recomputeOrgJobs } from "../src/recurrence.ts"
import { orgs, scheduledJobs } from "../src/schema.ts"
import { claimDueJobs, nextDueAt, tenancy, withOrg } from "../src/tenancy.ts"

/**
 * `claim_due_jobs` (migration 0020) against Postgres. Two orgs of its own, so
 * it shares no row with the other tenancy files, and every assertion reads
 * only the job ids it made: the function claims whatever is due, whoever owns
 * it.
 */
const ORG_ONE = crypto.randomUUID()
const ORG_TWO = crypto.randomUUID()
const ORGS = [ORG_ONE, ORG_TWO]

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

type Job = Partial<typeof scheduledJobs.$inferInsert>

/** Inserts `count` jobs per org, due an hour ago unless `over` says otherwise. */
async function seedJobs(count: number, over: Job = {}) {
  const made: { id: string; orgId: string }[] = []
  for (const orgId of ORGS) {
    await withOrg({ orgId }, async (db) => {
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID()
        made.push({ id, orgId })
        await db.insert(scheduledJobs).values({
          id,
          orgId,
          kind: "reminder",
          nextRunAt: new Date(Date.now() - HOUR),
          ...over,
        })
      }
    })
  }
  return made
}

const idsOf = (rows: { id: string }[]) => new Set(rows.map((row) => row.id))

/** Takes rows out of every later claim, so no other case sees them due. */
const pause = (rows: { id: string; orgId: string }[]) =>
  Promise.all(
    rows.map((row) =>
      withOrg({ orgId: row.orgId }, (db) =>
        db
          .update(scheduledJobs)
          .set({ pausedAt: new Date() })
          .where(eq(scheduledJobs.id, row.id))
      )
    )
  )

beforeAll(async () => {
  for (const orgId of ORGS) {
    await withOrg({ orgId }, (db) =>
      db.insert(orgs).values({
        id: orgId,
        slug: `claim-probe-${orgId.slice(0, 8)}`,
        name: "Claim probe (fixture)",
      })
    )
  }
})

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, ORGS, []))
  } finally {
    await client.end()
  }
})

describe("claim_due_jobs", () => {
  const kit = tenancy(connectionString(), { max: 1 })
  afterAll(() => kit.close())

  it("hands each due job to one caller when two call at once", async () => {
    // One connection each, so the two statements overlap in the database.
    const first = tenancy(connectionString(), { max: 1 })
    const second = tenancy(connectionString(), { max: 1 })
    try {
      for (let round = 0; round < 15; round++) {
        const mine = await seedJobs(4)
        const [a, b] = await Promise.all([
          claimDueJobs(first, 50),
          claimDueJobs(second, 50),
        ])
        const ours = idsOf(mine)
        const gotA = a.filter((row) => ours.has(row.jobId))
        const gotB = b.filter((row) => ours.has(row.jobId))
        const twice = gotA.filter((row) =>
          gotB.some((other) => other.jobId === row.jobId)
        )
        expect(twice, `round ${round}: claimed by both callers`).toEqual([])
        // Every job went to somebody, and came back under its own org.
        expect(gotA.length + gotB.length).toBe(mine.length)
        for (const row of [...gotA, ...gotB]) {
          expect(mine.find((job) => job.id === row.jobId)?.orgId).toBe(
            row.orgId
          )
        }
      }
    } finally {
      await first.close()
      await second.close()
    }
  }, 60_000)

  it("does not return a job it has already claimed", async () => {
    const mine = idsOf(await seedJobs(3))
    const first = await claimDueJobs(kit, 500)
    expect(first.filter((row) => mine.has(row.jobId))).toHaveLength(6)
    const again = await claimDueJobs(kit, 500)
    expect(again.filter((row) => mine.has(row.jobId))).toEqual([])
  })

  it("leaves a job that is paused or not yet due", async () => {
    const left = idsOf([
      ...(await seedJobs(1, { pausedAt: new Date() })),
      ...(await seedJobs(1, { nextRunAt: new Date(Date.now() + HOUR) })),
    ])
    const got = await claimDueJobs(kit, 500)
    expect(got.filter((row) => left.has(row.jobId))).toEqual([])
  })

  it("takes a job back only once its claim is older than the lease", async () => {
    const stale = idsOf(
      await seedJobs(1, { claimedAt: new Date(Date.now() - 30 * MINUTE) })
    )
    // Past a Queue consumer's 15 minutes, inside the lease: still running.
    const fresh = idsOf(
      await seedJobs(1, { claimedAt: new Date(Date.now() - 16 * MINUTE) })
    )
    const got = await claimDueJobs(kit, 500)
    expect(got.filter((row) => stale.has(row.jobId))).toHaveLength(2)
    expect(got.filter((row) => fresh.has(row.jobId))).toEqual([])
  })

  it("is due again at the next occurrence, once the run moves next_run_at on", async () => {
    const [job] = await seedJobs(1)
    if (!job) {
      throw new Error("no job seeded")
    }
    await claimDueJobs(kit, 500)
    // What the consumer does when the run ends, and then time passes.
    await withOrg({ orgId: job.orgId }, (db) =>
      db
        .update(scheduledJobs)
        .set({
          nextRunAt: new Date(Date.now() + 50),
          lastRunAt: new Date(),
          claimedAt: null,
        })
        .where(eq(scheduledJobs.id, job.id))
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const got = await claimDueJobs(kit, 500)
    expect(got.map((row) => row.jobId)).toContain(job.id)
  })

  it("takes no more than it is asked for", async () => {
    await seedJobs(3)
    expect(await claimDueJobs(kit, 0)).toEqual([])
    expect(await claimDueJobs(kit, 2)).toHaveLength(2)
  })
})

describe("next_due_at", () => {
  const kit = tenancy(connectionString(), { max: 1 })
  afterAll(() => kit.close())

  // Times older than any other test's rows, so each is the minimum when it
  // counts; every row is paused before the case ends, so no claim takes it.
  const LONG_AGO = new Date("2000-01-01T00:00:00.123Z")
  const LONGER_AGO = new Date("1999-01-01T00:00:00.456Z")

  it("is the earliest unpaused job, and a claimed one counts from its lease's end", async () => {
    const due = await seedJobs(1, { nextRunAt: LONG_AGO })
    const claimed = await seedJobs(1, {
      nextRunAt: LONGER_AGO,
      claimedAt: new Date(),
    })
    try {
      expect(await nextDueAt(kit)).toEqual(LONG_AGO)
      await pause(due)
      const next = await nextDueAt(kit)
      expect(next?.getTime()).toBeGreaterThan(LONG_AGO.getTime())
    } finally {
      await pause([...due, ...claimed])
    }
  })
})

describe("recomputeOrgJobs", () => {
  it("moves the org's upcoming recurring jobs to the new zone, and leaves the rest", async () => {
    const now = new Date("2026-10-19T12:00:00Z")
    const tomorrow = new Date("2026-10-20T09:00:00Z")
    const rows: Record<string, Job & { nextRunAt: Date }> = {
      recurring: { rule: "0 9 * * *", nextRunAt: tomorrow },
      oneOff: { rule: null, nextRunAt: tomorrow },
      due: { rule: "0 9 * * *", nextRunAt: new Date("2026-10-19T11:00:00Z") },
      claimed: { rule: "0 9 * * *", nextRunAt: tomorrow, claimedAt: now },
      paused: { rule: "0 9 * * *", nextRunAt: tomorrow, pausedAt: now },
    }
    const made = Object.entries(rows).map(([name, row]) => ({
      name,
      row,
      id: crypto.randomUUID(),
      orgId: ORG_ONE,
    }))
    try {
      const earliest = await withOrg({ orgId: ORG_ONE }, async (db) => {
        for (const { row, id } of made)
          await db
            .insert(scheduledJobs)
            .values({ ...row, id, orgId: ORG_ONE, kind: "heartbeat" })
        return recomputeOrgJobs(db, "America/New_York", now)
      })
      // 09:00 in New York on 2026-10-19 is 13:00Z, the first after now.
      expect(earliest).toEqual(new Date("2026-10-19T13:00:00Z"))
      const got = await withOrg({ orgId: ORG_ONE }, (db) =>
        db
          .select({ id: scheduledJobs.id, at: scheduledJobs.nextRunAt })
          .from(scheduledJobs)
      )
      const at = (name: string) =>
        got
          .find((row) => row.id === made.find((m) => m.name === name)?.id)
          ?.at.toISOString()
      expect(
        Object.fromEntries(made.map(({ name }) => [name, at(name)]))
      ).toEqual({
        recurring: "2026-10-19T13:00:00.000Z",
        oneOff: tomorrow.toISOString(),
        due: "2026-10-19T11:00:00.000Z",
        claimed: tomorrow.toISOString(),
        paused: tomorrow.toISOString(),
      })
    } finally {
      await pause(made)
    }
  })
})
