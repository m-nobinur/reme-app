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
  nextRun,
  SCHEDULE_CRON,
  scanDue,
} from "../src/schedule.ts"
import { freshOrg, kit } from "./fixture.ts"

const NY = "America/New_York"
const at = (iso: string) => new Date(iso)

/** Each occurrence after `from`, in order. */
function runs(rule: string, zone: string | null, from: string, n: number) {
  const out: string[] = []
  let after = at(from)
  for (let i = 0; i < n; i++) {
    after = nextRun(rule, zone, after)
    out.push(after.toISOString())
  }
  return out
}

describe("the next occurrence of a rule", () => {
  it("fires 01:30 once on the night it happens twice", () => {
    // 2026-11-01: 01:30 EDT is 05:30Z, and 01:30 EST an hour later is skipped.
    expect(runs("30 1 * * *", NY, "2026-10-31T12:00:00Z", 3)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ])
    expect(nextRun("30 1 * * *", NY, at("2026-11-01T05:30:00Z"))).toEqual(
      at("2026-11-02T06:30:00Z")
    )
  })

  it("fires 02:30 once, at 03:30, on the night it does not exist", () => {
    expect(runs("30 2 * * *", NY, "2026-03-07T12:00:00Z", 3)).toEqual([
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ])
  })

  it("is strictly after the instant it is given", () => {
    expect(nextRun("0 9 * * *", NY, at("2026-10-19T13:00:00Z"))).toEqual(
      at("2026-10-20T13:00:00Z")
    )
  })

  it("reads a zone-less org's rule in UTC", () => {
    expect(nextRun("0 7 * * 1", null, at("2026-10-19T08:00:00Z"))).toEqual(
      at("2026-10-26T07:00:00Z")
    )
  })

  it("refuses a rule that is not five-part cron, or a zone that is not one", () => {
    expect(() => nextRun("* * * * * *", NY, new Date())).toThrow()
    expect(() => nextRun("tomorrow", NY, new Date())).toThrow()
    expect(() => nextRun("0 9 * * *", "Not/AZone", new Date())).toThrow()
  })
})

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
})
