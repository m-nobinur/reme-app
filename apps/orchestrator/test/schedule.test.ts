import {
  eq,
  NEXT_DUE_KEY,
  type NextDue,
  orgs,
  scheduledJobs,
} from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  FALLBACK_MS,
  type JobMessage,
  SCHEDULE_CRON,
  scanDue,
} from "../src/schedule.ts"
import { freshOrg, kit } from "./fixture.ts"

const NY = "America/New_York"
/** A KV namespace in a map, with every call counted. */
function fakeKv(value?: NextDue) {
  const map = new Map<string, string>()
  if (value) map.set(NEXT_DUE_KEY, JSON.stringify(value))
  return {
    map,
    get: vi.fn(async (key: string) => {
      const raw = map.get(key)
      return raw === undefined ? null : JSON.parse(raw)
    }),
    put: vi.fn(async (key: string, raw: string) => {
      map.set(key, raw)
    }),
  }
}

/** An env whose database cannot be reached, so a scan that tries one throws. */
function asleep(kv: ReturnType<typeof fakeKv>) {
  return {
    SCHEDULE: kv,
    JOBS: { sendBatch: vi.fn() },
    get HYPERDRIVE(): never {
      throw new Error("Postgres was touched")
    },
  } as unknown as Env
}

describe("the KV guard", () => {
  const now = Date.UTC(2026, 9, 19, 12, 0)

  it("is the cron the handler matches", () => {
    expect(SCHEDULE_CRON).toBe("* * * * *")
  })

  it.each([
    ["a job due later", { next: now + 60_000, scanned: now - 60_000 }],
    ["no job at all", { next: null, scanned: now - 60_000 }],
    [
      "a scan just inside the fallback",
      { next: now + 60_000, scanned: now - FALLBACK_MS + 1 },
    ],
  ])("leaves Postgres asleep for %s", async (_, value) => {
    const kv = fakeKv(value)
    expect(await scanDue(asleep(kv), now)).toBeNull()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it.each([
    ["a job now due", { next: now, scanned: now - 60_000 }],
    [
      "the fallback scan, whatever KV says",
      { next: now + 60_000, scanned: now - FALLBACK_MS },
    ],
    ["nothing stored", undefined],
  ])("scans for %s", async (_, value) => {
    await expect(scanDue(asleep(fakeKv(value)), now)).rejects.toThrow(
      "Postgres was touched"
    )
  })

  it("scans on a wake even when KV says nothing is due", async () => {
    const kv = fakeKv({ next: now + 60_000, scanned: now - 60_000 })
    await expect(scanDue(asleep(kv), now, true)).rejects.toThrow(
      "Postgres was touched"
    )
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("a scan against a database", () => {
  afterAll(() => kit.close())

  it("claims a due job, sends it, and writes the new earliest time back", async () => {
    const orgId = await freshOrg(kit)
    const jobId = crypto.randomUUID()
    await kit.withOrg({ orgId }, async (db) => {
      await db.update(orgs).set({ timeZone: NY })
      await db.insert(scheduledJobs).values({
        id: jobId,
        orgId,
        kind: "reminder",
        nextRunAt: new Date(Date.now() - 1000),
      })
    })
    const kv = fakeKv({ next: Date.now() - 1000, scanned: Date.now() })
    const sent: { body: JobMessage }[] = []
    const env = {
      SCHEDULE: kv,
      JOBS: { sendBatch: vi.fn(async (b: typeof sent) => sent.push(...b)) },
      HYPERDRIVE: { connectionString: url },
    } as unknown as Env
    const now = Date.now()
    try {
      expect(await scanDue(env, now)).toBeGreaterThanOrEqual(1)
      // Other suites leave due jobs on a shared database and one scan takes
      // 100, oldest first, so scan until this newest one has gone too.
      for (let i = 0; i < 50 && !sent.some((m) => m.body.jobId === jobId); i++)
        await scanDue(env, now)
      expect(sent.map((m) => m.body)).toContainEqual({ jobId, orgId })
      const stored = JSON.parse(kv.map.get(NEXT_DUE_KEY) ?? "") as NextDue
      expect(stored.scanned).toBe(now)
      // Claimed now, so it counts from its lease's end, not its due time.
      expect(stored.next).toBeGreaterThan(now)
    } finally {
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(scheduledJobs)
          .set({ pausedAt: new Date() })
          .where(eq(scheduledJobs.id, jobId))
      )
    }
  })

  it("gives the claims back at once when the send fails, and leaves KV due", async () => {
    const orgId = await freshOrg(kit)
    const jobId = crypto.randomUUID()
    await kit.withOrg({ orgId }, (db) =>
      db.insert(scheduledJobs).values({
        id: jobId,
        orgId,
        kind: "reminder",
        nextRunAt: new Date(Date.now() - 1000),
      })
    )
    const before = { next: Date.now() - 1000, scanned: Date.now() }
    const kv = fakeKv(before)
    const env = {
      SCHEDULE: kv,
      JOBS: {
        sendBatch: vi.fn(async () => {
          throw new Error("queue down")
        }),
      },
      HYPERDRIVE: { connectionString: url },
    } as unknown as Env
    try {
      await expect(scanDue(env)).rejects.toThrow("queue down")
      const [job] = await kit.withOrg({ orgId }, (db) =>
        db
          .select({ claimedAt: scheduledJobs.claimedAt })
          .from(scheduledJobs)
          .where(eq(scheduledJobs.id, jobId))
      )
      expect(job?.claimedAt).toBeNull()
      expect(JSON.parse(kv.map.get(NEXT_DUE_KEY) ?? "")).toEqual(before)
    } finally {
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(scheduledJobs)
          .set({ pausedAt: new Date() })
          .where(eq(scheduledJobs.id, jobId))
      )
    }
  })
})
