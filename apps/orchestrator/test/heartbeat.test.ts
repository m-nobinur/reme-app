import {
  conversations,
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
  supersedePrivateFact,
} from "@workspace/db"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { type DeliveryMessage, deliveriesBatch } from "../src/deliveries.ts"
import {
  digest,
  heartbeatWith,
  type Models,
  SOURCES,
  type Source,
  surfacedKey,
} from "../src/heartbeat.ts"
import type { Spent } from "../src/heartbeat-write.ts"
import { HANDLERS, runJob } from "../src/jobs.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * The heartbeat through `runJob` on a live database, with the two models and
 * the Queue stood in for. Skipped without DATABASE_URL. The org is in
 * London; 2026-10-20 is BST, an hour ahead.
 */

const url = process.env.DATABASE_URL
const HOUR = 3_600_000
/** 12:00 in London. */
const NOON = new Date("2026-10-20T11:00:00Z")
const later = (at: Date, hours: number) => new Date(at.getTime() + hours * HOUR)
const SPENT: Spent = {
  model: "stand-in",
  cost_usd: 0.001,
  usage: { input_tokens: 100, output_tokens: 10 },
  ms: 5,
}

describe.skipIf(!url)("the heartbeat", () => {
  afterAll(() => kit.close())

  const queue = {
    send: vi.fn(async (_message: DeliveryMessage) => undefined),
    sendBatch: vi.fn(async () => undefined),
  }
  const env = {
    SCHEDULE: {
      get: async () => ({ next: null, scanned: 0 }),
      put: async () => undefined,
    },
    DELIVERIES: queue,
  } as unknown as Env

  /** What Jev answers and what the writer says, set per case. */
  let probability: number
  let reply: () => string
  const models = {
    gate: vi.fn<Models["gate"]>(async () => ({ probability, spent: SPENT })),
    write: vi.fn<Models["write"]>(async () => ({
      text: reply(),
      spent: SPENT,
    })),
  }
  const handlers = {
    ...HANDLERS,
    heartbeat: heartbeatWith(SOURCES, () => models),
  }

  let orgId: string
  let jobId: string
  let staffId: string

  beforeEach(async () => {
    probability = 0
    reply = () => "Your boiler engineer call is tomorrow at 07:00."
    models.gate.mockClear()
    models.write.mockClear()
    queue.send.mockClear()
    orgId = await freshOrg(kit)
    jobId = await kit.withOrg({ orgId }, async (db) => {
      await db.update(orgs).set({ timeZone: "Europe/London" })
      await ensureHeartbeat(db, NOON)
      const [chief] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "COS-001"))
      staffId = chief?.id as string
      await db
        .insert(conversations)
        .values({ orgId, kind: "assistant", createdByStaffId: staffId })
      const [job] = await db
        .select({ id: scheduledJobs.id })
        .from(scheduledJobs)
        .where(eq(scheduledJobs.kind, "heartbeat"))
      return job?.id as string
    })
  })

  /** Claims the job as due at `at` and runs it then. */
  async function beat(at: Date, using = handlers) {
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(scheduledJobs)
        .set({ nextRunAt: at, claimedAt: at })
        .where(eq(scheduledJobs.id, jobId))
    )
    return runJob(kit, env, { jobId, orgId }, using, at)
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

  const keys = (prefix: string) =>
    kit.withOrg({ orgId }, async (db) =>
      (
        await db
          .select({ key: deliveries.key })
          .from(deliveries)
          .where(sql`starts_with(${deliveries.key}, ${prefix})`)
      ).map((row) => row.key)
    )
  const ledger = () => keys("heartbeat-item:")
  const cap = () => keys("unprompted:")

  const spends = () =>
    kit.withOrg({ orgId }, async (db) =>
      (
        await db
          .select({ payload: events.payload })
          .from(events)
          .where(eq(events.type, "cos.background_step"))
      ).map((row) => row.payload)
    )

  const nextRunAt = () =>
    kit.withOrg({ orgId }, async (db) => {
      const [job] = await db
        .select({ at: scheduledJobs.nextRunAt })
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, jobId))
      return job?.at
    })

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

  /** A reminder due at `due`. */
  const remind = (due: Date, title = "Ring the boiler engineer") =>
    kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .insert(reminders)
        .values({
          orgId,
          title,
          dueAt: due,
          source: "assistant",
          createdByStaffId: staffId,
        })
        .returning({ id: reminders.id })
      return row?.id as string
    })

  /** A reminder due at `due`, and a domain alert raised at `raised`. */
  async function seed(due: Date, raised: Date) {
    const id = await remind(due)
    await record("alert.raised", raised, {
      kind: "domain.moved",
      domain_id: crypto.randomUUID(),
      primary_host: "www.example.test",
    })
    return id
  }

  describe("the job and the digest", () => {
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
      expect(models.gate).not.toHaveBeenCalled()
    })

    it("surfaces new items once, and an unchanged digest costs no model call", async () => {
      const id = await seed(later(NOON, 20), later(NOON, -2))
      expect(await beat(NOON)).toBe("ok")
      expect((await ledger()).sort()).toEqual(
        [
          expect.stringMatching(new RegExp(`^heartbeat-item:${orgId}:alert:`)),
          surfacedKey(orgId, `reminder:${id}:${later(NOON, 20).toISOString()}`),
        ].sort()
      )
      expect(models.gate).toHaveBeenCalledTimes(1)
      const next = later(NOON, 4)
      expect(await beat(next)).toBe("skipped")
      expect(await run(next)).toEqual({
        outcome: "skipped",
        detail: "unchanged",
      })
      expect(models.gate).toHaveBeenCalledTimes(1)
      expect(models.write).not.toHaveBeenCalled()
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
      expect(await beat(later(NOON, 4))).toBe("ok")
      expect(models.gate.mock.calls[1]?.[0]).toMatchObject({
        items: [{ kind: "reminder", title: "Ring the boiler engineer" }],
      })
    })

    it("treats a source that fails as no change: the ledger is left alone", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      const broken: Source = async () => {
        throw new Error("source unreadable")
      }
      const failing = {
        ...handlers,
        heartbeat: heartbeatWith([broken], () => models),
      }
      expect(await beat(NOON, failing)).toBe("failed")
      expect(await ledger()).toEqual([])
      expect(models.gate).not.toHaveBeenCalled()
      expect(await beat(later(NOON, 4))).toBe("ok")
      expect(await ledger()).toHaveLength(2)
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
      expect(models.gate).not.toHaveBeenCalled()
      expect(await beat(later(NOON, 4))).toBe("ok")
    })

    it("runs nothing in quiet hours, and the next beat waits for 08:00", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 1
      // 22:30 in London: a retry's backoff can land here.
      const night = new Date("2026-10-20T21:30:00Z")
      expect(await beat(night)).toBe("skipped")
      expect(await run(night)).toEqual({
        outcome: "skipped",
        detail: "quiet_hours",
      })
      expect(await ledger()).toEqual([])
      expect(models.gate).not.toHaveBeenCalled()
      expect(queue.send).not.toHaveBeenCalled()
      expect(await nextRunAt()).toEqual(new Date("2026-10-21T07:00:00Z"))
      // 20:00 in London is the last beat of the day.
      const evening = new Date("2026-10-20T19:00:00Z")
      expect(await beat(evening)).toBe("ok")
      expect(await nextRunAt()).toEqual(new Date("2026-10-21T07:00:00Z"))
    })
  })

  describe("the gate, the cap and the writer", () => {
    it("stops under the floor with no writer call and no cap taken", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.25
      await beat(NOON)
      expect(await run(NOON)).toEqual({
        outcome: "skipped",
        detail: "gate:0.25",
      })
      expect(models.write).not.toHaveBeenCalled()
      expect(await cap()).toEqual([])
      expect(await spends()).toEqual([
        expect.objectContaining({
          job: "heartbeat_gate",
          outcome: "stop",
          cost_usd: 0.001,
        }),
      ])
    })

    it("passes the floor on any dial and gives the writer the dial's bar", async () => {
      await kit.withOrg({ orgId }, (db) =>
        db.update(orgs).set({ proactivity: "high" })
      )
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.55
      await beat(NOON)
      expect(models.write).toHaveBeenCalledTimes(1)
      expect(models.write.mock.calls[0]?.[0]).toMatch(/on track/)
    })

    it("on a yes takes the day, writes, and sends in-app and by email to an owner who has not typed", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      await beat(NOON)
      expect(await run(NOON)).toEqual({
        outcome: "ok",
        detail: "sent:in_app,email",
      })
      expect(await cap()).toEqual([`unprompted:${orgId}:2026-10-20`])
      const key = `heartbeat:${orgId}:${jobId}:${NOON.toISOString()}`
      expect(queue.send.mock.calls.map(([m]) => m)).toEqual([
        {
          orgId,
          key,
          channel: "in_app",
          message: {
            text: ["Your boiler engineer call is tomorrow at 07:00."],
          },
        },
        {
          orgId,
          key: `${key}:email`,
          channel: "email",
          subject: "An update from Reme",
          text: "Your boiler engineer call is tomorrow at 07:00.",
        },
      ])
      // The writer reads dates in the owner's zone, and the items as data.
      const [system, data] = models.write.mock.calls[0] ?? []
      expect(system).toMatch(/\[quiet\]/)
      expect(data).toMatchObject({
        now: "Tuesday, 20 October 2026 at 12:00",
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "reminder",
            since: "Wednesday, 21 October 2026 at 08:00",
          }),
          expect.objectContaining({ kind: "alert", host: "www.example.test" }),
        ]),
      })
      expect((await spends()).map((s) => s.job)).toEqual([
        "heartbeat_gate",
        "heartbeat_writer",
      ])
    })

    it("gives the writer the owner profile's lines, never their ids or sources", async () => {
      await kit.withOrg({ orgId }, (db) =>
        supersedePrivateFact(db, {
          orgId,
          key: "owner.profile",
          factType: "owner.profile",
          value: {
            lines: [
              {
                id: crypto.randomUUID(),
                text: "Prefers calls after 4pm",
                source: "owner_said",
                at: NOON.toISOString(),
              },
              {
                id: crypto.randomUUID(),
                text: "Quotes go out on Fridays",
                source: "reflection",
                at: NOON.toISOString(),
              },
            ],
          },
          provenance: { source: "owner_stated", confidence: 1 },
        })
      )
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      await beat(NOON)
      const data = models.write.mock.calls[0]?.[1] as { owner_profile?: string }
      expect(data.owner_profile).toBe(
        "Prefers calls after 4pm\nQuotes go out on Fridays"
      )
    })

    it("sends in-app only when the owner has typed since the last heartbeat", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      await kit.withOrg({ orgId }, async (db) => {
        const [chat] = await db
          .select({ id: conversations.id })
          .from(conversations)
        await db.execute(sql`
          insert into conversation_messages (conversation_id, id, org_id, format, content)
          values (${chat?.id}, ${crypto.randomUUID()}, ${orgId}, 'ai-sdk/v6',
            '{"role":"user","parts":[{"type":"text","text":"hi"}]}'::jsonb)`)
      })
      await beat(NOON)
      expect(await run(NOON)).toEqual({ outcome: "ok", detail: "sent:in_app" })
    })

    it("stops a second unprompted message the same day before the writer", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      await beat(NOON)
      await remind(later(NOON, 22), "Order more microfibre cloths")
      const next = later(NOON, 4)
      await beat(next)
      expect(await run(next)).toEqual({ outcome: "skipped", detail: "capped" })
      expect(models.gate).toHaveBeenCalledTimes(2)
      expect(models.write).toHaveBeenCalledTimes(1)
    })

    it("gives the day back when the writer stays quiet, so a later beat can speak", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      reply = () => "[quiet] nothing the owner needs today"
      await beat(NOON)
      expect(await run(NOON)).toEqual({
        outcome: "skipped",
        detail: "quiet: nothing the owner needs today",
      })
      expect(await cap()).toEqual([])
      expect(queue.send).not.toHaveBeenCalled()

      reply = () => "Your microfibre order reminder is due tomorrow."
      await remind(later(NOON, 22), "Order more microfibre cloths")
      const next = later(NOON, 4)
      await beat(next)
      expect(await run(next)).toEqual({
        outcome: "ok",
        detail: "sent:in_app,email",
      })
    })

    it("gives the day back when the writer fails or breaks a limit", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      reply = () => {
        throw new Error("upstream 502")
      }
      await beat(NOON)
      expect(await run(NOON)).toMatchObject({
        outcome: "failed",
        detail: expect.stringMatching(/^writer_error:/),
      })
      expect(await cap()).toEqual([])

      reply = () => "One. Two. Three. Four."
      await remind(later(NOON, 22), "Order more microfibre cloths")
      const next = later(NOON, 4)
      await beat(next)
      expect(await run(next)).toEqual({
        outcome: "failed",
        detail: "over_limit:sentences",
      })
      expect(await cap()).toEqual([])
      expect(queue.send).not.toHaveBeenCalled()
    })

    it("records a gate that fails as an error, with the ledger kept", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      models.gate.mockRejectedValueOnce(new Error("timeout"))
      await beat(NOON)
      expect(await run(NOON)).toMatchObject({
        outcome: "failed",
        detail: expect.stringMatching(/^gate_error:/),
      })
      expect(await ledger()).toHaveLength(2)
    })

    it("tells the writer what it said last time, and when", async () => {
      await seed(later(NOON, 20), later(NOON, -2))
      probability = 0.95
      await beat(NOON)
      // The consumer posts the in-app message, which is what the owner saw.
      const inApp = queue.send.mock.calls
        .map(([m]) => m)
        .filter((m) => m.channel === "in_app")
      await deliveriesBatch(
        {
          messages: inApp.map((body) => ({
            body,
            attempts: 1,
            ack: () => undefined,
            retry: () => undefined,
          })),
        } as unknown as MessageBatch<DeliveryMessage>,
        env as never,
        kit
      )
      await remind(later(NOON, 30), "Send the invoice to Mrs Patel")
      const tomorrow = later(NOON, 24)
      await beat(tomorrow)
      expect(models.write.mock.calls[1]?.[1]).toMatchObject({
        last_message: {
          text: "Your boiler engineer call is tomorrow at 07:00.",
          sent: expect.stringMatching(/ 2026 at /),
        },
      })
    })
  })
})
