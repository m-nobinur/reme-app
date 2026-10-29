import {
  conversationMessages,
  conversations,
  deliveries,
  ensureHeartbeat,
  eq,
  events,
  newUlid,
  openTask,
  orgs,
  scheduledJobs,
  setStep,
  staff,
  taskFollowups,
} from "@workspace/db"
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest"
import { heartbeatWith, type Models, SOURCES } from "../src/heartbeat.ts"
import type { Spent } from "../src/heartbeat-write.ts"
import { HANDLERS, runJob } from "../src/jobs.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * A week of hourly heartbeats on a London org with two steps waiting on the
 * owner, a fake clock and the models stood in for (Jev always says yes).
 * Skipped without DATABASE_URL.
 */

const url = process.env.DATABASE_URL
const HOUR = 3_600_000
/**
 * Tuesday 2037-10-20, 01:00 in London. Ahead of the real clock, so no scan in
 * a suite alongside finds a beat due; 2037 has 2026's weekdays and clock change.
 */
const START = new Date("2037-10-20T00:00:00Z")
const at = (hours: number) => new Date(START.getTime() + hours * HOUR)
const SPENT: Spent = {
  model: "stand-in",
  cost_usd: 0.001,
  usage: { input_tokens: 100, output_tokens: 10 },
  ms: 5,
}

describe.skipIf(!url)("heartbeat follow-ups over a week", () => {
  afterAll(() => kit.close())

  it("never repeats a fingerprint, never speaks mid-turn, and a dismissed one never returns", async () => {
    const env = {
      SCHEDULE: {
        get: async () => ({ next: null, scanned: 0 }),
        put: async () => undefined,
      },
      DELIVERIES: { send: vi.fn(), sendBatch: vi.fn() },
    } as unknown as Env
    const orgId = await freshOrg(kit)
    const now = { at: START }
    let turnDuringWrite = false
    let written: unknown[] = []
    const cosContext = (when: Date) =>
      kit.withOrg({ orgId }, (db) =>
        db.insert(events).values({
          eventId: newUlid(),
          idempotencyKey: newUlid(),
          orgId,
          type: "cos.context",
          occurredAt: when,
          payload: {},
        })
      )
    const models: Models = {
      gate: async () => ({ probability: 1, spent: SPENT }),
      write: async (_system, data) => {
        written = (data as { items: unknown[] }).items
        // The owner opens the chat while the writer is still drafting.
        if (turnDuringWrite) await cosContext(now.at)
        return { text: "Your change is still waiting on you.", spent: SPENT }
      },
    }
    const handlers = {
      ...HANDLERS,
      heartbeat: heartbeatWith(SOURCES, () => models),
    }

    const { jobId, conversationId, address } = await kit.withOrg(
      { orgId },
      async (db) => {
        await db.update(orgs).set({ timeZone: "Europe/London" })
        await ensureHeartbeat(db, START)
        const [chief] = await db
          .select({ id: staff.id })
          .from(staff)
          .where(eq(staff.staffCode, "COS-001"))
        const [conversation] = await db
          .insert(conversations)
          .values({
            orgId,
            kind: "assistant",
            createdByStaffId: chief?.id as string,
          })
          .returning({ id: conversations.id })
        const [job] = await db
          .select({ id: scheduledJobs.id })
          .from(scheduledJobs)
          .where(eq(scheduledJobs.kind, "heartbeat"))
        const task = await openTask(db, orgId, "address", {
          name: "brightclean.co.uk",
        })
        await setStep(db, task, "records", {
          state: "blocked",
          blocked_on: "owner_action",
          changed_at: at(0),
        })
        const google = await openTask(db, orgId, "google")
        await setStep(db, google, "sign_in", {
          state: "blocked",
          blocked_on: "owner_action",
          changed_at: at(1),
        })
        return {
          jobId: job?.id as string,
          conversationId: conversation?.id as string,
          address: task,
        }
      }
    )
    // Paused at the end, so the job never reads as the earliest due time in
    // the schedule suite on the shared database.
    onTestFinished(async () => {
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(scheduledJobs)
          .set({ pausedAt: new Date() })
          .where(eq(scheduledJobs.id, jobId))
      )
    })

    // Wednesday 08:00 to 10:00 in London are inside a turn, and at 11:00 a
    // turn starts while the writer drafts.
    const inTurn = new Set([31, 32, 33])
    const midWrite = 34
    const delivered: { hour: number; waiting: string[] }[] = []
    for (let hour = 0; hour < 7 * 24; hour++) {
      now.at = at(hour)
      written = []
      turnDuringWrite = hour === midWrite
      if (inTurn.has(hour))
        await cosContext(new Date(now.at.getTime() - 300_000))
      // Wednesday 13:30: the owner answers the first follow-up.
      if (hour === 36)
        await kit.withOrg({ orgId }, (db) =>
          db.insert(conversationMessages).values({
            conversationId,
            id: crypto.randomUUID(),
            orgId,
            format: "ai-sdk/v6",
            content: {
              role: "user",
              parts: [{ type: "text", text: "not now" }],
            },
            createdAt: at(35.5),
          })
        )
      // Friday: the DNS change goes in and then fails, so the step waits again.
      if (hour === 80 || hour === 81)
        await kit.withOrg({ orgId }, (db) =>
          setStep(db, address, "records", {
            state: hour === 80 ? "in_progress" : "blocked",
            blocked_on: hour === 80 ? null : "owner_action",
            changed_at: now.at,
          })
        )
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(scheduledJobs)
          // Claimed by the real clock and paused between beats, so a scan in
          // a suite running alongside never finds this job due.
          .set({ nextRunAt: now.at, claimedAt: new Date(), pausedAt: null })
          .where(eq(scheduledJobs.id, jobId))
      )
      expect(
        await runJob(kit, env, { jobId, orgId }, handlers, now.at)
      ).not.toMatch(/failed|paused/)
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(scheduledJobs)
          .set({ pausedAt: new Date() })
          .where(eq(scheduledJobs.id, jobId))
      )
      const key = `heartbeat:${orgId}:${jobId}:${now.at.toISOString()}`
      const [sent] = await kit.withOrg({ orgId }, (db) =>
        db.select().from(deliveries).where(eq(deliveries.key, key))
      )
      if (sent)
        delivered.push({
          hour,
          waiting: (written as { waiting_for?: string }[]).flatMap((item) =>
            item.waiting_for ? [item.waiting_for] : []
          ),
        })
    }

    // The DNS change waits a day, so Wednesday 12:00 after the turns; signing
    // in waits the same, so the next day's first beat out of quiet hours.
    expect(delivered).toEqual([
      { hour: 35, waiting: ["your DNS change"] },
      { hour: 55, waiting: ["signing in to Google"] },
    ])
    const rows = await kit.withOrg({ orgId }, (db) =>
      db.select().from(taskFollowups)
    )
    expect(
      rows.map((row) => [row.fingerprint.split(":")[2], row.dismissedAt])
    ).toEqual(
      expect.arrayContaining([
        ["records", at(35.5)],
        ["sign_in", null],
      ])
    )
    expect(rows).toHaveLength(2)
  }, 120_000)
})
