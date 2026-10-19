import {
  deliveries,
  ensureHeartbeat,
  eq,
  events,
  jobRuns,
  newUlid,
  orgs,
  reminders,
  scheduledJobs,
  sql,
  staff,
} from "@workspace/db"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  digest,
  heartbeatWith,
  type Source,
  surfacedKey,
} from "../src/heartbeat.ts"
import { HANDLERS, runJob } from "../src/jobs.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * The heartbeat through `runJob` on a live database. Skipped without
 * DATABASE_URL. The org is in London; 2026-10-20 is BST, an hour ahead.
 */

const url = process.env.DATABASE_URL
const HOUR = 3_600_000
/** 12:00 in London. */
const NOON = new Date("2026-10-20T11:00:00Z")
const later = (at: Date, hours: number) => new Date(at.getTime() + hours * HOUR)

describe.skipIf(!url)("the heartbeat", () => {
  afterAll(() => kit.close())

  const env = {
    SCHEDULE: {
      get: async () => ({ next: null, scanned: 0 }),
      put: async () => undefined,
    },
  } as unknown as Env
  let orgId: string
  let jobId: string
  let staffId: string

  beforeEach(async () => {
    orgId = await freshOrg(kit)
    jobId = await kit.withOrg({ orgId }, async (db) => {
      await db.update(orgs).set({ timeZone: "Europe/London" })
      await ensureHeartbeat(db, NOON)
      const [chief] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "COS-001"))
      staffId = chief?.id as string
      const [job] = await db
        .select({ id: scheduledJobs.id })
        .from(scheduledJobs)
        .where(eq(scheduledJobs.kind, "heartbeat"))
      return job?.id as string
    })
  })

  /** Claims the job as due at `at` and runs it then. */
  async function beat(at: Date, handlers = HANDLERS) {
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(scheduledJobs)
        .set({ nextRunAt: at, claimedAt: at })
        .where(eq(scheduledJobs.id, jobId))
    )
    return runJob(kit, env, { jobId, orgId }, handlers, at)
  }

  const run = (at: Date) =>
    kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select({ outcome: jobRuns.outcome, detail: jobRuns.detail })
        .from(jobRuns)
        .where(
          sql`${jobRuns.jobId} = ${jobId} and ${jobRuns.runAt} = ${at.toISOString()}::timestamptz`
        )
      return row
    })

  const ledger = () =>
    kit.withOrg({ orgId }, async (db) =>
      (
        await db
          .select({ key: deliveries.key })
          .from(deliveries)
          .where(sql`starts_with(${deliveries.key}, 'heartbeat-item:')`)
      ).map((row) => row.key)
    )

  const nextRunAt = () =>
    kit.withOrg({ orgId }, async (db) => {
      const [job] = await db
        .select({ at: scheduledJobs.nextRunAt })
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, jobId))
      return job?.at
    })

  /** A reminder due at `due`, and a domain alert raised at `raised`. */
  async function seed(due: Date, raised: Date) {
    return kit
      .withOrg({ orgId }, async (db) => {
        const [row] = await db
          .insert(reminders)
          .values({
            orgId,
            title: "Ring the boiler engineer",
            dueAt: due,
            source: "assistant",
            createdByStaffId: staffId,
          })
          .returning({ id: reminders.id })
        return row?.id as string
      })
      .then(async (id) => {
        await record("alert.raised", raised, {
          kind: "domain.moved",
          domain_id: crypto.randomUUID(),
          primary_host: "www.example.test",
        })
        return id
      })
  }

  /** An event that happened at `at`, which `appendEvent` cannot backdate. */
  const record = (type: string, at: Date, payload: Record<string, unknown>) =>
    kit.withOrg({ orgId }, (db) =>
      db.insert(events).values({
        eventId: newUlid(),
        idempotencyKey: newUlid(),
        orgId,
        type,
        occurredAt: at,
        payload,
      })
    )

  it("is created on the default dial, every 4 hours, and ensuring it again changes nothing", async () => {
    await kit.withOrg({ orgId }, async (db) => {
      const [job] = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.kind, "heartbeat"))
      expect(job?.rule).toBe("0 */4 * * *")
      expect(job?.nextRunAt).toEqual(new Date("2026-10-20T15:00:00Z"))
      expect(await ensureHeartbeat(db, NOON)).toBeNull()
    })
  })

  it("follows the dial: a new rule on high, no job when off", async () => {
    await kit.withOrg({ orgId }, async (db) => {
      await db.update(orgs).set({ proactivity: "high" })
      expect(await ensureHeartbeat(db, NOON)).toEqual(
        new Date("2026-10-20T12:00:00Z")
      )
      await db.update(orgs).set({ proactivity: "off" })
      expect(await ensureHeartbeat(db, NOON)).toBeNull()
      const jobs = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.kind, "heartbeat"))
      expect(jobs).toEqual([])
    })
  })

  it("records an empty digest as skipped", async () => {
    expect(await beat(NOON)).toBe("skipped")
    expect(await run(NOON)).toEqual({ outcome: "skipped", detail: "empty" })
  })

  it("surfaces new items once, and an unchanged digest stops without a model", async () => {
    const id = await seed(later(NOON, 20), later(NOON, -2))
    expect(await beat(NOON)).toBe("ok")
    expect(await run(NOON)).toEqual({ outcome: "ok", detail: "new:2" })
    expect((await ledger()).sort()).toEqual(
      [
        expect.stringMatching(new RegExp(`^heartbeat-item:${orgId}:alert:`)),
        surfacedKey(orgId, `reminder:${id}:${later(NOON, 20).toISOString()}`),
      ].sort()
    )
    const next = later(NOON, 4)
    expect(await beat(next)).toBe("skipped")
    expect(await run(next)).toEqual({ outcome: "skipped", detail: "unchanged" })
  })

  it("reads the same digest when only the time has moved", async () => {
    await seed(later(NOON, 20), later(NOON, -2))
    const [now, then] = await kit.withOrg({ orgId }, async (db) => [
      await digest(db, NOON),
      await digest(db, later(NOON, 3)),
    ])
    expect(then).toEqual(now)
    expect(JSON.stringify(now)).not.toMatch(
      /ago|hours?|minutes?|today|tomorrow/i
    )
  })

  it("surfaces a moved reminder again, since its key carries the new time", async () => {
    const id = await seed(later(NOON, 20), later(NOON, -2))
    await beat(NOON)
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(reminders)
        .set({ dueAt: later(NOON, 22) })
        .where(eq(reminders.id, id))
    )
    const next = later(NOON, 4)
    expect(await beat(next)).toBe("ok")
    expect(await run(next)).toEqual({ outcome: "ok", detail: "new:1" })
  })

  it("treats a source that fails as no change: the ledger is left alone", async () => {
    await seed(later(NOON, 20), later(NOON, -2))
    const broken: Source = async () => {
      throw new Error("source unreadable")
    }
    const failing = { ...HANDLERS, heartbeat: heartbeatWith([broken]) }
    expect(await beat(NOON, failing)).toBe("failed")
    expect(await ledger()).toEqual([])
    const next = later(NOON, 4)
    expect(await beat(next)).toBe("ok")
    expect(await run(next)).toEqual({ outcome: "ok", detail: "new:2" })
  })

  it("skips without looking when the owner had a CoS turn in the last 15 minutes", async () => {
    await seed(later(NOON, 20), later(NOON, -2))
    await record("cos.context", later(NOON, -0.2), {})
    expect(await beat(NOON)).toBe("skipped")
    expect(await run(NOON)).toEqual({
      outcome: "skipped",
      detail: "owner_active",
    })
    expect(await ledger()).toEqual([])
    const next = later(NOON, 4)
    expect(await beat(next)).toBe("ok")
  })

  it("runs nothing in quiet hours, and the next beat waits for 08:00", async () => {
    await seed(later(NOON, 20), later(NOON, -2))
    // 22:30 in London: a retry's backoff can land here.
    const night = new Date("2026-10-20T21:30:00Z")
    expect(await beat(night)).toBe("skipped")
    expect(await run(night)).toEqual({
      outcome: "skipped",
      detail: "quiet_hours",
    })
    expect(await ledger()).toEqual([])
    expect(await nextRunAt()).toEqual(new Date("2026-10-21T07:00:00Z"))
    // 20:00 in London is the last beat of the day.
    const evening = new Date("2026-10-20T19:00:00Z")
    expect(await beat(evening)).toBe("ok")
    expect(await nextRunAt()).toEqual(new Date("2026-10-21T07:00:00Z"))
  })
})
