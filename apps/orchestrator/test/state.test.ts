import type { AssignmentState } from "@workspace/contracts"
import {
  assignments,
  assignmentTransitions,
  eq,
  events,
  sql,
} from "@workspace/db"
import fc from "fast-check"
import { ulid } from "ulid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  advance,
  assignmentCost,
  cancel,
  claim,
  parkForBudget,
  REPAIR_LIMIT,
  TERMINAL,
  TransitionError,
  transition,
} from "../src/state.ts"
import {
  freshOrg as freshOrgIn,
  kit,
  newAssignment as newAssignmentIn,
} from "./fixture.ts"

/**
 * The §8.4 properties M2 promises, driven against a real database because the
 * guarantees live in constraints and transactions, not in TypeScript.
 */
const url = process.env.DATABASE_URL
// Skipped rather than failed without a database, the way the api suite does:
// the unit job has none, and `floors.json` carries a `+db` floor so the
// database job is where these count.
const live = describe.skipIf(!url)

afterAll(() => kit.close())
const freshOrg = () => freshOrgIn(kit)
const newAssignment = (orgId: string, kind?: string) =>
  newAssignmentIn(kit, orgId, kind)

const NON_TERMINAL = (
  [
    "queued",
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
    "awaiting_review",
    "revising",
    "release_candidate",
    "blocked_on_information",
    "blocked_on_approval",
    "repairing",
    "paused",
  ] as const
).filter((s) => !TERMINAL.includes(s))

/** One legal path from `queued` to each state. */
const PATH: Record<AssignmentState, AssignmentState[]> = {
  queued: [],
  briefing: ["briefing"],
  planning: ["briefing", "planning"],
  implementing: ["briefing", "planning", "implementing"],
  validating: ["briefing", "planning", "implementing", "validating"],
  preview_ready: [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
  ],
  awaiting_review: [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
    "awaiting_review",
  ],
  revising: [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
    "awaiting_review",
    "revising",
  ],
  release_candidate: [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
    "awaiting_review",
    "release_candidate",
  ],
  published: [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
    "awaiting_review",
    "release_candidate",
    "published",
  ],
  blocked_on_information: [
    "briefing",
    "planning",
    "implementing",
    "blocked_on_information",
  ],
  blocked_on_approval: [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
    "awaiting_review",
    "blocked_on_approval",
  ],
  repairing: ["briefing", "planning", "implementing", "repairing"],
  paused: ["briefing", "planning", "implementing", "paused"],
  failed: ["briefing", "planning", "implementing", "repairing", "failed"],
  cancelled: ["cancelled"],
}

/** Edges out of each state, as the machine allows them (not counting pause/cancel). */
const NEXT: Record<AssignmentState, AssignmentState[]> = {
  queued: ["briefing"],
  briefing: ["planning"],
  planning: ["implementing"],
  implementing: ["validating", "blocked_on_information", "repairing", "failed"],
  validating: ["preview_ready", "repairing", "failed"],
  preview_ready: ["awaiting_review"],
  awaiting_review: ["revising", "release_candidate", "blocked_on_approval"],
  revising: ["validating"],
  release_candidate: ["published"],
  published: [],
  blocked_on_information: ["implementing"],
  blocked_on_approval: ["release_candidate"],
  repairing: ["implementing", "failed"],
  paused: [],
  failed: [],
  cancelled: [],
}

async function walk(
  ids: { orgId: string; assignmentId: string },
  path: AssignmentState[]
) {
  for (const to of path) await advance(kit, ids, to)
}

async function current(ids: { orgId: string; assignmentId: string }) {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    if (!row) throw new Error("gone")
    return row
  })
}

let sharedOrg: string
beforeAll(async () => {
  if (url) sharedOrg = await freshOrg()
})

live("no transition without an event", () => {
  it("every transition row cites a state_changed event, one per version", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 12 }),
        async (choices) => {
          const ids = await newAssignment(await freshOrg())
          let state: AssignmentState = "queued"
          for (const choice of choices) {
            const options = NEXT[state]
            if (options.length === 0) break
            const to = options[choice % options.length] as AssignmentState
            try {
              await advance(kit, ids, to)
              state = to
            } catch (error) {
              // The repair budget is the only refusal a legal walk can hit.
              expect(error).toBeInstanceOf(TransitionError)
              expect((error as TransitionError).code).toBe(
                "assignment.repair_budget_exhausted"
              )
              break
            }
          }
          const { transitions, changed, row } = await kit.withOrg(
            { orgId: ids.orgId },
            async (db) => ({
              transitions: await db
                .select()
                .from(assignmentTransitions)
                .where(
                  eq(assignmentTransitions.assignmentId, ids.assignmentId)
                ),
              changed: await db
                .select()
                .from(events)
                .where(
                  sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'assignment.state_changed'`
                ),
              row: await current(ids),
            })
          )
          expect(row.state).toBe(state)
          expect(transitions.length).toBe(row.version)
          expect(changed.length).toBe(transitions.length)
          const byEvent = new Map(changed.map((e) => [e.eventId, e]))
          for (const t of transitions) {
            const event = byEvent.get(t.eventId)
            expect(
              event,
              `transition v${t.version} cites no event`
            ).toBeDefined()
            expect(event?.payload).toMatchObject({
              from: t.fromState,
              to: t.toState,
              version: t.version,
            })
          }
          expect(new Set(changed.map((e) => e.payload.version)).size).toBe(
            changed.length
          )
        }
      ),
      { numRuns: 12, seed: 20260914 }
    )
  }, 120_000)
})

live("cancel", () => {
  it.each(NON_TERMINAL)("is legal from %s, and idempotent", async (state) => {
    const ids = await newAssignment(await freshOrg())
    await walk(ids, PATH[state])
    expect(await cancel(kit, ids)).toBe("cancelled")
    const after = await current(ids)
    expect(after.state).toBe("cancelled")
    expect(await cancel(kit, ids)).toBe("cancelled")
    expect((await current(ids)).version).toBe(after.version)
  })

  it.each(["published", "failed"] as const)(
    "leaves %s alone",
    async (state) => {
      const ids = await newAssignment(await freshOrg())
      await walk(ids, PATH[state])
      expect(await cancel(kit, ids)).toBe(state)
    }
  )
})

live("cost from the log", () => {
  /** A logged turn with a cost, or any other event carrying the same shape. */
  const logged = (
    ids: { orgId: string; assignmentId: string },
    sessionId: string,
    seq: number,
    type: string,
    total: number
  ) =>
    kit.withOrg({ orgId: ids.orgId }, (db) =>
      db.insert(events).values({
        eventId: ulid(),
        orgId: ids.orgId,
        assignmentId: ids.assignmentId,
        sessionId,
        seq,
        type,
        occurredAt: new Date(),
        idempotencyKey: ulid(),
        payload: { response: { usage: { cost: { total } } } },
      })
    )

  it("sums runtime.turn and nothing else, and freezes the sum at close", async () => {
    const ids = await newAssignment(await freshOrg())
    await walk(ids, PATH.implementing)
    const session = crypto.randomUUID()
    await logged(ids, session, 0, "runtime.turn", 0.0012)
    await logged(ids, session, 1, "runtime.turn", 0.0034)
    await logged(ids, session, 2, "runtime.turn_request", 9)
    // Another assignment's turn never lands on this one.
    const other = await newAssignment(ids.orgId, "report.write")
    await logged(other, crypto.randomUUID(), 0, "runtime.turn", 5)

    expect(
      await kit.withOrg({ orgId: ids.orgId }, (db) =>
        assignmentCost(db, ids.assignmentId)
      )
    ).toBeCloseTo(0.0046, 6)
    expect((await current(ids)).costUsd).toBeNull()

    await cancel(kit, ids)
    expect((await current(ids)).costUsd).toBeCloseTo(0.0046, 6)
    const [closed] = await kit.withOrg({ orgId: ids.orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'assignment.state_changed' and ${events.payload}->>'to' = 'cancelled'`
        )
    )
    expect(closed?.payload.cost_usd).toBeCloseTo(0.0046, 6)
  })

  it("is zero for an assignment that never called a model", async () => {
    const ids = await newAssignment(await freshOrg())
    await walk(ids, PATH.failed)
    expect((await current(ids)).costUsd).toBe(0)
  })
})

live("the optimistic lock", () => {
  it("rejects a stale expected_version as transient and moves nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -3, max: 6 }), async (offset) => {
        const ids = await newAssignment(sharedOrg, "probe.lock")
        await walk(ids, ["briefing"])
        const row = await current(ids)
        const expected = row.version + (offset === 0 ? 1 : offset)
        const attempt = kit.withOrg({ orgId: ids.orgId }, (db) =>
          transition(db, { ...ids, to: "planning", expectedVersion: expected })
        )
        await expect(attempt).rejects.toMatchObject({
          code: "assignment.stale_version",
          errorClass: "transient",
        })
        const after = await current(ids)
        expect(after.state).toBe("briefing")
        expect(after.version).toBe(row.version)
      }),
      { numRuns: 8, seed: 20260914 }
    )
  })

  it("refuses an edge the machine does not have as validation", async () => {
    const ids = await newAssignment(sharedOrg, "probe.lock")
    const attempt = advance(kit, ids, "published")
    await expect(attempt).rejects.toMatchObject({
      code: "assignment.illegal_transition",
      errorClass: "validation",
    })
  })

  it("resumes a pause to the state it left, and nowhere else", async () => {
    const ids = await newAssignment(sharedOrg, "probe.lock")
    await walk(ids, [
      "briefing",
      "planning",
      "implementing",
      "validating",
      "paused",
    ])
    await expect(advance(kit, ids, "implementing")).rejects.toMatchObject({
      code: "assignment.illegal_transition",
    })
    await advance(kit, ids, "validating")
    expect((await current(ids)).state).toBe("validating")
  })

  it("parks on a spent budget from implementing and leaves only back to implementing", async () => {
    const ids = await newAssignment(sharedOrg, "probe.lock")
    await walk(ids, ["briefing", "planning", "implementing"])
    // The facade's guard refused the second model call on a $0.01 cap.
    await parkForBudget(kit, ids, { cap_usd: 0.01, spent_usd: 0.012 })
    expect((await current(ids)).state).toBe("blocked_on_approval")
    const events_ = await kit.withOrg({ orgId: ids.orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'budget.exhausted'`
        )
    )
    expect(events_).toHaveLength(1)
    expect(events_[0]?.payload).toMatchObject({ cap_usd: 0.01 })
    // The unreviewed publish path stays closed.
    await expect(advance(kit, ids, "release_candidate")).rejects.toMatchObject({
      code: "assignment.illegal_transition",
    })
    await advance(kit, ids, "implementing")
    expect((await current(ids)).state).toBe("implementing")
  })

  it("never reaches release_candidate from a budget park, whatever the walk", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 6 }),
        async (choices) => {
          const ids = await newAssignment(await freshOrg())
          await walk(ids, ["briefing", "planning", "implementing"])
          await parkForBudget(kit, ids, { cap_usd: 1, spent_usd: 1 })
          const attempts: AssignmentState[] = [
            "release_candidate",
            "published",
            "awaiting_review",
            "validating",
          ]
          for (const choice of choices) {
            const to = attempts[choice % attempts.length] as AssignmentState
            await expect(advance(kit, ids, to)).rejects.toMatchObject({
              code: "assignment.illegal_transition",
            })
          }
          expect((await current(ids)).state).toBe("blocked_on_approval")
        }
      ),
      { numRuns: 6, seed: 20260915 }
    )
  }, 60_000)

  it(`enters repairing at most ${REPAIR_LIMIT} times`, async () => {
    const ids = await newAssignment(sharedOrg, "probe.lock")
    await walk(ids, ["briefing", "planning", "implementing"])
    for (let i = 0; i < REPAIR_LIMIT; i++) {
      await advance(kit, ids, "repairing")
      await advance(kit, ids, "implementing")
    }
    await expect(advance(kit, ids, "repairing")).rejects.toMatchObject({
      code: "assignment.repair_budget_exhausted",
    })
  })
})

live("two assignments on one site serialise", () => {
  it("the second stays queued until the first settles, with one site.locked event", async () => {
    const org = await freshOrg()
    const first = await newAssignment(org)
    const second = await newAssignment(org)
    expect(await claim(kit, first, true)).toMatchObject({ claimed: true })
    expect(await claim(kit, second, true)).toMatchObject({ claimed: false })
    expect(await claim(kit, second, false)).toMatchObject({ claimed: false })
    expect((await current(second)).state).toBe("queued")
    const locked = await kit.withOrg({ orgId: org }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${second.assignmentId} and ${events.type} = 'site.locked'`
        )
    )
    expect(locked.length).toBe(1)
    await cancel(kit, first)
    expect(await claim(kit, second, false)).toMatchObject({ claimed: true })
    expect((await current(second)).state).toBe("briefing")
  })

  it("a paused writer releases the site", async () => {
    const org = await freshOrg()
    const first = await newAssignment(org)
    const second = await newAssignment(org)
    await walk(first, ["briefing", "planning", "implementing", "paused"])
    expect(await claim(kit, second, true)).toMatchObject({ claimed: true })
  })
})

live("a new build supersedes a preview nobody reviewed", () => {
  const toPreview = [
    "briefing",
    "planning",
    "implementing",
    "validating",
    "preview_ready",
  ] as const

  it("cancels the preview_ready assignment in the claim's transaction and says who superseded it", async () => {
    const org = await freshOrg()
    const first = await newAssignment(org)
    await walk(first, [...toPreview])
    const second = await newAssignment(org)
    expect(await claim(kit, second, true)).toEqual({
      claimed: true,
      superseded: first.assignmentId,
    })
    expect((await current(first)).state).toBe("cancelled")
    expect((await current(second)).state).toBe("briefing")
    const [move] = await kit.withOrg({ orgId: org }, (db) =>
      db
        .select()
        .from(assignmentTransitions)
        .where(
          sql`${assignmentTransitions.assignmentId} = ${first.assignmentId} and ${assignmentTransitions.toState} = 'cancelled'`
        )
    )
    expect(move?.reason).toBe("superseded")
    const [event] = await kit.withOrg({ orgId: org }, (db) =>
      db
        .select()
        .from(events)
        .where(eq(events.eventId, move?.eventId ?? ""))
    )
    expect(event?.payload).toMatchObject({
      to: "cancelled",
      superseded_by: second.assignmentId,
    })
  })

  it("never supersedes an assignment an owner is looking at", async () => {
    const org = await freshOrg()
    const first = await newAssignment(org)
    await walk(first, [...toPreview, "awaiting_review"])
    const second = await newAssignment(org)
    expect(await claim(kit, second, true)).toEqual({
      claimed: false,
      superseded: null,
    })
    expect((await current(first)).state).toBe("awaiting_review")
    expect((await current(second)).state).toBe("queued")
  })
})
