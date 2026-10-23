import { Blueprint } from "@workspace/contracts"
import { assignments, eq, events, sql } from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import { freshOrg, kit } from "./fixture.ts"

// app.ts loads both at import time; neither is reached here.
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { insertAssignment } = await import("../src/app.ts")
const { fallbackBlueprint, planRound } = await import("../src/planner.ts")
const {
  afterFailure,
  decide,
  readyText,
  retryingText,
  SYSTEM_CAUSES,
  stoppedText,
} = await import("../src/retry.ts")
const { advance } = await import("../src/state.ts")

const ended = {
  origin: "owner" as const,
  kind: "site.build",
  lane: "full",
  retry_of: null,
  reason: "gates.repair_budget_exhausted",
  busy: false,
}

describe("whether a failed build is started again", () => {
  it.each(Object.keys(SYSTEM_CAUSES))(
    "retries an owner's build for %s",
    (reason) => {
      expect(decide({ ...ended, reason })).toBe("retry")
    }
  )

  it("retries a full rebuild of a live site, and only says a quick change failed", () => {
    expect(decide({ ...ended, kind: "site.revise" })).toBe("retry")
    expect(decide({ ...ended, kind: "site.revise", lane: "quick" })).toBe(
      "stop"
    )
  })

  it("never retries a retry", () => {
    expect(decide({ ...ended, retry_of: "a" })).toBe("stop")
  })

  it("stays quiet for the owner's own wait, the console, and a newer build", () => {
    for (const reason of ["information.unanswered", "blueprint.undecided"]) {
      expect(decide({ ...ended, reason })).toBe("quiet")
    }
    expect(decide({ ...ended, reason: "constructor" })).toBe("quiet")
    expect(decide({ ...ended, origin: "console" })).toBe("quiet")
    expect(decide({ ...ended, busy: true })).toBe("quiet")
  })
})

describe("what the owner reads", () => {
  const plan = fallbackBlueprint({ facts: [], recent: [] })
  const lines = [
    ...Object.keys(SYSTEM_CAUSES).flatMap((reason) => [
      retryingText("site.build", reason),
      stoppedText("site.revise", reason),
    ]),
    readyText("site.build", plan),
    readyText("site.revise", null),
  ]

  it.each(lines)("%s", (line) => {
    // No code, id, number, name of ours or em dash.
    expect(line).not.toMatch(/[a-z]+[._][a-z]+|\d|Reme|Ava|—/)
    expect(line.length).toBeLessThan(240)
  })

  it("names the planned pages by the names the owner picked them by", () => {
    const pages = (ids: string[]) => ({
      ...plan,
      pages: ids.map((page) => ({ ...plan.pages[0], page })),
    })
    expect(readyText("site.build", pages(["home", "quote"]))).toBe(
      "Your website draft is ready, with Home and Request a quote pages. Preview it, then approve it or tell me what to change."
    )
    expect(
      readyText("site.build", pages(["home", "about", "service", "quote"]))
    ).toContain(
      "with Home, About and Request a quote pages, plus a page for each service."
    )
    expect(readyText("site.build", null)).toBe(
      "Your website draft is ready. Preview it, then approve it or tell me what to change."
    )
  })
})

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)

afterAll(() => kit.close())

live("a failed owner build's retry", () => {
  const created: string[] = []
  const env = {
    ASSIGNMENTS: {
      create: async ({ id }: { id: string }) => {
        created.push(id)
        return { id }
      },
    },
  } as unknown as Pick<Env, "ASSIGNMENTS">

  /** An owner's build with a plan whose photos were drawn, failed for `reason`. */
  async function failedBuild(orgId: string, reason: string, key: string) {
    const plan = fallbackBlueprint({ facts: [], recent: [] })
    const drawn: Blueprint = {
      ...plan,
      images: plan.images.map((s) =>
        s.source === "generated" ? { ...s, asset_id: crypto.randomUUID() } : s
      ),
    }
    const made = await kit.withOrg({ orgId }, async (db) => {
      const result = await insertAssignment(db, orgId, key, true, {
        kind: "site.build",
        goal: "Build the site from the canonical facts.",
        model: "A",
        withhold: [],
        lane: "full",
        change_kind: null,
      })
      if (!("row" in result)) throw new Error("not created")
      await db
        .update(assignments)
        .set({ blueprint: drawn })
        .where(eq(assignments.id, result.row.id))
      return result.row.id
    })
    return fail({ orgId, assignmentId: made }, reason)
  }

  async function fail(
    ids: { orgId: string; assignmentId: string },
    reason: string
  ) {
    await advance(kit, ids, "briefing")
    await advance(kit, ids, "planning")
    await advance(kit, ids, "failed", { reason })
    return ids
  }

  it("starts one retry with the plan, however often the step runs, and says so", async () => {
    const orgId = await freshOrg(kit)
    const ids = await failedBuild(orgId, "gates.repair_budget_exhausted", "k1")
    created.length = 0
    const first = await afterFailure(env, kit, ids)
    const again = await afterFailure(env, kit, ids)
    expect(again).toEqual(first)
    expect(first.note?.key).toBe(`site.retrying:${ids.assignmentId}`)
    expect(created).toEqual([first.retry_id])

    const [row] = await kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(assignments)
        .where(eq(assignments.id, first.retry_id as string))
    )
    expect(row?.workflowInstanceId).toBe(first.retry_id)
    const plan = Blueprint.parse(row?.blueprint)
    expect(plan.images.some((s) => s.source === "generated")).toBe(true)
    expect(
      plan.images.filter((s) => s.source === "generated" && s.asset_id)
    ).toEqual([])
    const [made] = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ payload: events.payload })
        .from(events)
        .where(
          sql`${events.assignmentId} = ${first.retry_id} and ${events.type} = 'assignment.created'`
        )
    )
    expect(made?.payload).toMatchObject({
      origin: "owner",
      retry_of: ids.assignmentId,
    })
    // Its planning keeps the plan and calls no model.
    const kept = await planRound({
      env: {},
      kit,
      ids: { orgId, assignmentId: first.retry_id as string },
      complete: () => {
        throw new Error("no model call on a retry")
      },
    })
    expect(kept).toEqual({ round: 1, source: "retry", attempts: 0 })

    // The retry fails too: said once, never started a third time.
    const retry = await fail(
      { orgId, assignmentId: first.retry_id as string },
      "developer.stalled"
    )
    const last = await afterFailure(env, kit, retry)
    expect(last).toEqual({
      retry_id: null,
      note: {
        key: `site.stopped:${retry.assignmentId}`,
        text: "Your website build couldn't finish: it stopped making progress. Say try again, or tell me what to change.",
      },
    })
    expect(created).toHaveLength(1)
  })

  it("leaves a build that waited on the owner as it ended", async () => {
    const orgId = await freshOrg(kit)
    const ids = await failedBuild(orgId, "blueprint.undecided", "k2")
    expect(await afterFailure(env, kit, ids)).toEqual({
      retry_id: null,
      note: null,
    })
  })
})
