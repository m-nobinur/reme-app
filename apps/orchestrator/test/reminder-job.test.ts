import {
  conversationMessages,
  conversations,
  deliveries,
  eq,
  orgs,
  reminders,
  scheduledJobs,
  staff,
} from "@workspace/db"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeliveryMessage } from "../src/deliveries.ts"
import { HANDLERS, runJob } from "../src/jobs.ts"
import { reminderJob } from "../src/reminder-job.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * The reminder handler through `runJob` on a live database, with the Queue
 * stood in for. Skipped without DATABASE_URL.
 */

const url = process.env.DATABASE_URL
const MINUTE = 60_000
const DUE = new Date("2026-10-20T08:00:00Z")
/** The reminder was set a day before it fell due. */
const SET = new Date(DUE.getTime() - 24 * 60 * MINUTE)

describe.skipIf(!url)("firing a reminder", () => {
  afterAll(() => kit.close())

  const queue = {
    send: vi.fn(
      async (_message: DeliveryMessage, _options?: unknown) => undefined
    ),
  }
  const env = {
    SCHEDULE: {
      get: async () => ({ next: null, scanned: 0 }),
      put: async () => undefined,
    },
    DELIVERIES: queue,
  } as unknown as Env
  let orgId: string
  let conversationId: string
  let staffId: string

  beforeEach(async () => {
    queue.send.mockClear()
    orgId = await freshOrg(kit)
    await kit.withOrg({ orgId }, async (db) => {
      const [chief] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "COS-001"))
      staffId = chief?.id as string
      const [chat] = await db
        .insert(conversations)
        .values({ orgId, kind: "assistant", createdByStaffId: staffId })
        .returning({ id: conversations.id })
      conversationId = chat?.id as string
    })
  })

  /** A reminder and its claimed job, due at `due`. */
  async function reminder(
    over: Partial<typeof reminders.$inferInsert> = {},
    due: Date | null = DUE
  ) {
    return kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .insert(reminders)
        .values({
          orgId,
          title: "Ring the boiler engineer",
          dueAt: due,
          source: "assistant",
          conversationId,
          createdByStaffId: staffId,
          createdAt: SET,
          ...over,
        })
        .returning()
      const [job] = await db
        .insert(scheduledJobs)
        .values({
          orgId,
          kind: "reminder",
          refId: row?.id,
          nextRunAt: due ?? DUE,
          claimedAt: due ?? DUE,
        })
        .returning({ id: scheduledJobs.id })
      return { id: row?.id as string, jobId: job?.id as string }
    })
  }

  const fire = (jobId: string, now: Date, handlers = HANDLERS) =>
    runJob(kit, env, { jobId, orgId }, handlers, now)

  const sent = () => queue.send.mock.calls.map(([message]) => message)

  const rows = () =>
    kit.withOrg({ orgId }, (db) => db.select().from(deliveries))

  /** The owner typed something at `at`. */
  const typed = (at: Date) =>
    kit.withOrg({ orgId }, (db) =>
      db.insert(conversationMessages).values({
        conversationId,
        id: crypto.randomUUID(),
        orgId,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text: "hello" }] },
        createdAt: at,
      })
    )

  it("posts to the reminder's own conversation and emails an owner who has not been in", async () => {
    const { id, jobId } = await reminder()
    expect(await fire(jobId, new Date(DUE.getTime() + 20_000))).toBe("ok")
    const key = `reminder:${id}:2026-10-20T08:00:00.000Z`
    expect(sent()).toEqual([
      {
        orgId,
        key,
        channel: "in_app",
        message: { text: ["Reminder: “Ring the boiler engineer”"] },
        conversationId,
      },
      {
        orgId,
        key: `${key}:email`,
        channel: "email",
        subject: "Reminder: Ring the boiler engineer",
        text: "Reminder: “Ring the boiler engineer”",
      },
    ])
    expect((await rows()).map((row) => row.key).sort()).toEqual(
      [key, `${key}:email`].sort()
    )
  })

  it("posts to the newest conversation for the owner's own, and sends no email to one who typed since", async () => {
    const { jobId } = await reminder({ source: "owner", conversationId: null })
    await typed(new Date(SET.getTime() + 60 * MINUTE))
    expect(await fire(jobId, DUE)).toBe("ok")
    const [post, ...rest] = sent()
    expect(post).toMatchObject({ channel: "in_app" })
    expect(post).not.toHaveProperty("conversationId")
    expect(rest).toEqual([])
  })

  it("still emails when the owner's last message came before the reminder", async () => {
    const { jobId } = await reminder()
    await typed(new Date(SET.getTime() - 60 * MINUTE))
    await fire(jobId, DUE)
    expect(sent().map((m) => m.channel)).toEqual(["in_app", "email"])
  })

  it("says when it was due, in the org's zone, once it runs more than five minutes late", async () => {
    await kit.withOrg({ orgId }, (db) =>
      db.update(orgs).set({ timeZone: "America/New_York" })
    )
    const { jobId } = await reminder()
    await fire(jobId, new Date(DUE.getTime() + 6 * MINUTE))
    expect(sent()[0]).toMatchObject({
      message: {
        text: [
          "Reminder: “Ring the boiler engineer”",
          "It was due on Tuesday 20 October at 04:00 GMT-4.",
        ],
      },
    })
  })

  it("does not mention the time when the run is within five minutes", async () => {
    const { jobId } = await reminder()
    await fire(jobId, new Date(DUE.getTime() + 5 * MINUTE))
    expect(sent()[0]).toMatchObject({
      message: { text: ["Reminder: “Ring the boiler engineer”"] },
    })
  })

  it("skips a reminder that is done, one that is gone and one with no time", async () => {
    const done = await reminder({ doneAt: new Date(DUE.getTime() - MINUTE) })
    const none = await reminder({}, null)
    const gone = await reminder()
    await kit.withOrg({ orgId }, (db) =>
      db.delete(reminders).where(eq(reminders.id, gone.id))
    )
    for (const { jobId } of [done, none, gone])
      expect(await fire(jobId, DUE)).toBe("skipped")
    expect(queue.send).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
  })

  it("delivers the same occurrence once, and a re-armed time as a new one", async () => {
    const { id, jobId } = await reminder()
    await fire(jobId, DUE)
    // The same occurrence again, as a job re-armed to the same time would be.
    await kit.withOrg({ orgId }, (db) =>
      db.delete(scheduledJobs).where(eq(scheduledJobs.id, jobId))
    )
    const again = await kit.withOrg({ orgId }, async (db) => {
      const [job] = await db
        .insert(scheduledJobs)
        .values({
          orgId,
          kind: "reminder",
          refId: id,
          nextRunAt: DUE,
          claimedAt: DUE,
        })
        .returning({ id: scheduledJobs.id })
      return job?.id as string
    })
    queue.send.mockClear()
    await fire(again, DUE)
    expect(queue.send).not.toHaveBeenCalled()

    const later = new Date(DUE.getTime() + 60 * MINUTE)
    const moved = await kit.withOrg({ orgId }, async (db) => {
      await db
        .update(reminders)
        .set({ dueAt: later })
        .where(eq(reminders.id, id))
      const [job] = await db
        .insert(scheduledJobs)
        .values({
          orgId,
          kind: "reminder",
          refId: id,
          nextRunAt: later,
          claimedAt: later,
        })
        .returning({ id: scheduledJobs.id })
      return job?.id as string
    })
    await fire(moved, later)
    expect(sent()[0]).toMatchObject({
      key: `reminder:${id}:2026-10-20T09:00:00.000Z`,
    })
  })

  it("sends nothing when the run rolls back after the handler, and leaves no delivery row", async () => {
    const { jobId } = await reminder()
    const failing = {
      reminder: async (run: Parameters<typeof reminderJob>[0]) => {
        await reminderJob(run)
        throw new Error("rolled back")
      },
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(await fire(jobId, DUE, failing)).toBe("failed")
    expect(await rows()).toEqual([])
    expect(queue.send).not.toHaveBeenCalled()
  })

  it("sends only after the commit: the rows are visible when the Queue is told", async () => {
    const { jobId } = await reminder()
    const seen: number[] = []
    queue.send.mockImplementationOnce(async () => {
      seen.push((await rows()).length)
    })
    await fire(jobId, DUE)
    expect(seen).toEqual([2])
  })

  it("keeps the committed run and its pending rows when the Queue refuses the send", async () => {
    const { jobId } = await reminder()
    queue.send.mockRejectedValue(new Error("queue down"))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(await fire(jobId, DUE)).toBe("ok")
    expect((await rows()).map((row) => row.state)).toEqual([
      "pending",
      "pending",
    ])
    queue.send.mockReset()
  })
})
