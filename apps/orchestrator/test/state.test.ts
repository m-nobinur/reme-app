import type { AssignmentState } from "@workspace/contracts"
import {
  assignments,
  assignmentTransitions,
  eq,
  events,
  orgs,
  sql,
  staff,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  advance,
  cancel,
  claim,
  REPAIR_LIMIT,
  TERMINAL,
  TransitionError,
  transition,
} from "../src/state.ts"

/**
 * The §8.4 properties M2 promises, driven against a real database because the
 * guarantees live in constraints and transactions, not in TypeScript. Fails
 * without `DATABASE_URL` rather than skipping: a floor that counts skipped
 * cases is a gate that proves nothing.
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("state.test.ts needs DATABASE_URL")

const kit: Tenancy = tenancy(url)
afterAll(() => kit.close())

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
  implementing: ["validating", "blocked_on_information", "repairing"],
  validating: ["preview_ready", "repairing"],
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

/**
 * A fresh fictional org per case with the two staff rows an assignment needs,
 * written through `withOrg` so the suite holds nothing the app role cannot.
 * Rows stay behind: `events` is append-only, so nothing here can delete them.
 */
async function freshOrg(): Promise<string> {
  const orgId = crypto.randomUUID()
  await kit.withOrg({ orgId }, async (db) => {
    await db.insert(orgs).values({
      id: orgId,
      slug: `state-test-${orgId.slice(0, 8)}`,
      name: "State machine probe (fixture)",
    })
    // One root per org: the Chief is the root and the Developer reports to it.
    const [chief] = await db
      .insert(staff)
      .values({
        orgId,
        staffCode: "COS-001",
        displayName: "Chief",
        kind: "agent",
        status: "active",
      })
      .returning({ id: staff.id })
    await db.insert(staff).values({
      orgId,
      staffCode: "DEV-001",
      displayName: "Dev",
      kind: "agent",
      status: "active",
      managerId: chief?.id,
    })
  })
  return orgId
}

async function newAssignment(orgId: string, kind = "site.build") {
  return kit.withOrg({ orgId }, async (db) => {
    const [dev] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.staffCode, "DEV-001"))
    if (!dev) throw new Error("no developer")
    const [row] = await db
      .insert(assignments)
      .values({
        orgId,
        staffId: dev.id,
        createdByStaffId: dev.id,
        kind,
        goal: "probe",
        acceptanceCriteria: ["probe"],
        factSnapshotId: crypto.randomUUID(),
        budgetUsd: 1,
        idempotencyKey: crypto.randomUUID(),
      })
      .returning()
    if (!row) throw new Error("no row")
    return { orgId, assignmentId: row.id }
  })
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
  sharedOrg = await freshOrg()
})

describe("no transition without an event", () => {
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

describe("cancel", () => {
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

describe("the optimistic lock", () => {
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

describe("two assignments on one site serialise", () => {
  it("the second stays queued until the first settles, with one site.locked event", async () => {
    const org = await freshOrg()
    const first = await newAssignment(org)
    const second = await newAssignment(org)
    expect(await claim(kit, first, true)).toBe(true)
    expect(await claim(kit, second, true)).toBe(false)
    expect(await claim(kit, second, false)).toBe(false)
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
    expect(await claim(kit, second, false)).toBe(true)
    expect((await current(second)).state).toBe("briefing")
  })

  it("a paused writer releases the site", async () => {
    const org = await freshOrg()
    const first = await newAssignment(org)
    const second = await newAssignment(org)
    await walk(first, ["briefing", "planning", "implementing", "paused"])
    expect(await claim(kit, second, true)).toBe(true)
  })
})
