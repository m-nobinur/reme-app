import {
  eq,
  events,
  jobRuns,
  memberships,
  NEXT_DUE_KEY,
  type NextDue,
  orgs,
  scheduledJobs,
  sql,
} from "@workspace/db"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  backoffMinutes,
  type Handler,
  jobsBatch,
  MAX_FAILURES,
  PAUSED_TEXT,
  runJob,
} from "../src/jobs.ts"
import type { JobMessage, JobsQueueMessage } from "../src/schedule.ts"
import { freshOrg, kit } from "./fixture.ts"

/** Every post the pause asked of the chat. */
const posts = vi.hoisted(() => [] as unknown[])
vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/db")>()),
  postAssistantMessage: async (_kit: unknown, post: unknown) => {
    posts.push(post)
    return "posted"
  },
}))

describe("backoff", () => {
  it("doubles from two minutes and stops at an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMinutes)).toEqual([
      2, 4, 8, 16, 32, 60, 60,
    ])
  })
})

describe("a wake on the jobs queue", () => {
  // Never connected: a wake only scans, and the kit connects on first query.
  const env = {
    HYPERDRIVE: { connectionString: "postgres://wake@127.0.0.1:9/none" },
  } as unknown as Env
  const wake = () => {
    const message = { body: { kind: "scan" }, ack: vi.fn(), retry: vi.fn() }
    return {
      message,
      batch: {
        messages: [message],
      } as unknown as MessageBatch<JobsQueueMessage>,
    }
  }

  it("scans now, past the KV guard, and acks", async () => {
    const scan = vi.fn(async () => 0)
    const { message, batch } = wake()
    await jobsBatch(batch, env, scan)
    expect(scan).toHaveBeenCalledExactlyOnceWith(env, expect.any(Number), true)
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it("retries a wake whose scan failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { message, batch } = wake()
    await jobsBatch(batch, env, async () => {
      throw new Error("Postgres away")
    })
    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    vi.mocked(console.error).mockRestore()
  })

  it("redrives the org a redrive names, and acks", async () => {
    const scan = vi.fn(async () => 0)
    const redrive = vi.fn(async () => [])
    const message = {
      body: { kind: "redrive", orgId: "org-1" },
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const batch = {
      messages: [message],
    } as unknown as MessageBatch<JobsQueueMessage>
    await jobsBatch(batch, env, scan, redrive)
    expect(redrive).toHaveBeenCalledExactlyOnceWith(
      env,
      expect.anything(),
      "org-1"
    )
    expect(scan).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
  })
})

const url = process.env.DATABASE_URL
const NY = "America/New_York"
const MINUTE = 60_000
/** 01:30 EDT on 2026-11-01, the first of the night's two 01:30s. */
const FIRST_0130 = new Date("2026-11-01T05:30:00Z")
const SECOND_0130 = new Date("2026-11-01T06:30:00Z")
const after = (t: Date, ms = 10_000) => new Date(t.getTime() + ms)

function fakeKv(next: number | null) {
  const map = new Map<string, string>([
    [NEXT_DUE_KEY, JSON.stringify({ next, scanned: 0 } satisfies NextDue)],
  ])
  return {
    map,
    stored: () => JSON.parse(map.get(NEXT_DUE_KEY) ?? "null") as NextDue,
    get: async (key: string) => JSON.parse(map.get(key) ?? "null"),
    put: async (key: string, raw: string) => void map.set(key, raw),
  }
}

describe.skipIf(!url)("running a claimed job", () => {
  afterAll(() => kit.close())

  let orgId: string
  let kv: ReturnType<typeof fakeKv>
  let env: Env
  const calls: string[] = []
  const counting: Handler = async ({ job }) => {
    calls.push(job.id)
    return undefined
  }

  beforeEach(async () => {
    orgId = await freshOrg(kit)
    await kit.withOrg({ orgId }, (db) => db.update(orgs).set({ timeZone: NY }))
    kv = fakeKv(Date.parse("2027-01-01T00:00:00Z"))
    env = { SCHEDULE: kv } as unknown as Env
    calls.length = 0
    posts.length = 0
  })

  /** A job the cron has just claimed, due at `due`. */
  async function claimed(due: Date, rule: string | null = null) {
    const jobId = crypto.randomUUID()
    await kit.withOrg({ orgId }, (db) =>
      db.insert(scheduledJobs).values({
        id: jobId,
        orgId,
        kind: "reminder",
        rule,
        nextRunAt: due,
        claimedAt: due,
      })
    )
    return { jobId, orgId } satisfies JobMessage
  }

  const read = (jobId: string) =>
    kit.withOrg({ orgId }, async (db) => ({
      job: (
        await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId))
      )[0],
      runs: await db.select().from(jobRuns).where(eq(jobRuns.jobId, jobId)),
    }))

  const claimAgain = (jobId: string) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .update(scheduledJobs)
        .set({ claimedAt: sql`next_run_at` })
        .where(eq(scheduledJobs.id, jobId))
    )

  it("fires a reminder at 01:30 on 2026-11-01 once, and a redelivery writes no second run", async () => {
    const message = await claimed(FIRST_0130)
    const handlers = { reminder: counting }
    expect(await runJob(kit, env, message, handlers, after(FIRST_0130))).toBe(
      "ok"
    )
    expect(await runJob(kit, env, message, handlers, after(FIRST_0130))).toBe(
      "stale"
    )
    // The night's second 01:30, an hour later.
    expect(await runJob(kit, env, message, handlers, after(SECOND_0130))).toBe(
      "stale"
    )
    const { job, runs } = await read(message.jobId)
    expect(calls).toEqual([message.jobId])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runAt: FIRST_0130, outcome: "ok" })
    // A one-off never fires again.
    expect(job).toMatchObject({ claimedAt: null, failures: 0 })
    expect(job?.pausedAt).toEqual(after(FIRST_0130))
  })

  it("runs a redelivery racing the first delivery once", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    const handlers = { reminder: counting }
    const both = await Promise.all([
      runJob(kit, env, message, handlers, after(FIRST_0130)),
      runJob(kit, env, message, handlers, after(FIRST_0130)),
    ])
    expect(both.sort()).toEqual(["ok", "stale"])
    expect(calls).toHaveLength(1)
    expect((await read(message.jobId)).runs).toHaveLength(1)
  })

  it("moves a daily 01:30 past the night's second 01:30, in the org's zone", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    await runJob(kit, env, message, { reminder: counting }, after(FIRST_0130))
    // The cron could claim it again; it is not due until the next night.
    await claimAgain(message.jobId)
    expect(
      await runJob(
        kit,
        env,
        message,
        { reminder: counting },
        after(SECOND_0130)
      )
    ).toBe("stale")
    const { job, runs } = await read(message.jobId)
    expect(calls).toHaveLength(1)
    expect(runs).toHaveLength(1)
    expect(job?.nextRunAt).toEqual(new Date("2026-11-02T06:30:00Z"))
    expect(job?.pausedAt).toBeNull()
    // And pulls the stored earliest time forward to it.
    expect(kv.stored().next).toBe(Date.parse("2026-11-02T06:30:00Z"))
  })

  it("runs a daily job that missed three days once, and moves it past now", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    const late = new Date("2026-11-04T12:00:00Z")
    expect(await runJob(kit, env, message, { reminder: counting }, late)).toBe(
      "ok"
    )
    const { job, runs } = await read(message.jobId)
    expect(calls).toHaveLength(1)
    expect(runs.map((r) => r.runAt)).toEqual([FIRST_0130])
    expect(job?.nextRunAt).toEqual(new Date("2026-11-05T06:30:00Z"))
  })

  it("records a kind with no handler as skipped and moves on", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    expect(await runJob(kit, env, message, {}, after(FIRST_0130))).toBe(
      "skipped"
    )
    const { job, runs } = await read(message.jobId)
    expect(runs[0]).toMatchObject({ outcome: "skipped", detail: "no handler" })
    expect(job?.nextRunAt).toEqual(new Date("2026-11-02T06:30:00Z"))
  })

  it("rolls back what a failing handler wrote, and backs off", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    const failing: Handler = async ({ db }) => {
      await db.update(orgs).set({ name: "written by a failed run" })
      throw new Error("handler failed")
    }
    const now = after(FIRST_0130)
    expect(await runJob(kit, env, message, { reminder: failing }, now)).toBe(
      "failed"
    )
    const { job, runs } = await read(message.jobId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runAt: FIRST_0130, outcome: "failed" })
    expect(job).toMatchObject({ failures: 1, claimedAt: null, pausedAt: null })
    expect(job?.nextRunAt).toEqual(new Date(now.getTime() + 2 * MINUTE))
    expect(kv.stored().next).toBe(now.getTime() + 2 * MINUTE)
    const [org] = await kit.withOrg({ orgId }, (db) =>
      db.select({ name: orgs.name }).from(orgs)
    )
    expect(org?.name).not.toBe("written by a failed run")
  })

  it("pauses after five failures in a row, raises an alert and tells the owner once", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    const failing: Handler = async () => {
      throw new Error("handler failed")
    }
    const ran: string[] = []
    for (let i = 0; i < MAX_FAILURES; i++) {
      const { job } = await read(message.jobId)
      const now = after(job?.nextRunAt as Date)
      await claimAgain(message.jobId)
      ran.push(await runJob(kit, env, message, { reminder: failing }, now))
    }
    expect(ran).toEqual(["failed", "failed", "failed", "failed", "paused"])
    const { job, runs } = await read(message.jobId)
    expect(runs.map((r) => r.outcome)).toEqual(Array(5).fill("failed"))
    expect(job?.failures).toBe(5)
    expect(job?.pausedAt).not.toBeNull()
    const alerts = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ payload: events.payload })
        .from(events)
        .where(eq(events.type, "alert.raised"))
    )
    expect(alerts.map((a) => a.payload)).toEqual([
      {
        kind: "job.paused",
        job_id: message.jobId,
        job_kind: "reminder",
        failures: 5,
      },
    ])
    expect(posts).toEqual([
      {
        orgId,
        key: `job-paused:${message.jobId}:${job?.pausedAt?.toISOString()}`,
        message: { text: [PAUSED_TEXT] },
      },
    ])
    // Paused: a stray message for it runs nothing.
    await claimAgain(message.jobId)
    expect(
      await runJob(kit, env, message, { reminder: failing }, new Date())
    ).toBe("stale")
  })

  it("pauses a closed org's job without running it", async () => {
    const message = await claimed(FIRST_0130, "30 1 * * *")
    await kit.withOrg({ orgId }, (db) =>
      db.update(memberships).set({ status: "inactive" })
    )
    expect(
      await runJob(kit, env, message, { reminder: counting }, after(FIRST_0130))
    ).toBe("closed")
    const { job, runs } = await read(message.jobId)
    expect(calls).toEqual([])
    expect(runs).toEqual([])
    expect(job).toMatchObject({ claimedAt: null })
    expect(job?.pausedAt).not.toBeNull()
  })

  it("acks what ran and retries what could not be recorded", async () => {
    const message = await claimed(new Date(Date.now() - MINUTE))
    const ack = vi.fn()
    const retry = vi.fn()
    const lost = { ack: vi.fn(), retry: vi.fn() }
    await jobsBatch(
      {
        messages: [
          { body: message, ack, retry },
          { body: { jobId: message.jobId, orgId: "not-an-org" }, ...lost },
        ],
      } as unknown as MessageBatch<JobMessage>,
      { ...env, HYPERDRIVE: { connectionString: url } } as unknown as Env
    )
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    expect(lost.retry).toHaveBeenCalledOnce()
    expect(lost.ack).not.toHaveBeenCalled()
    expect((await read(message.jobId)).runs).toMatchObject([
      { outcome: "skipped" },
    ])
  })
})
