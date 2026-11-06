import {
  AddressStageName,
  AGENT_NOTE,
  Blueprint,
  BUILD_FAILURES,
} from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  DAILY_CAP_USD,
  eq,
  events,
  newUlid,
  offerOf,
  scheduledJobs,
  sql,
  supersedeFact,
} from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { writeText } from "../src/heartbeat-write.ts"
import { openChat } from "./chat.ts"
import { freshOrg, kit, newAssignment } from "./fixture.ts"
import { previewed } from "./site.ts"

// app.ts loads both at import time; neither is reached here.
vi.mock("../src/sandbox.ts", () => ({
  workKey: (ids: { assignmentId: string }) => `work/${ids.assignmentId}`,
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { insertAssignment } = await import("../src/app.ts")
const { fallbackBlueprint, planRound } = await import("../src/planner.ts")
const {
  addressLine,
  afterFailure,
  decide,
  NARRATED_PER_HOUR,
  narrate,
  noteProblem,
  noteResumed,
  postNote,
  readyNote,
  readyText,
  resumedText,
  retryingText,
  stoppedText,
  DRAFT_BACK,
  tryAgain,
} = await import("../src/retry.ts")
const { workKey } = await import("../src/sandbox.ts")
const { advance } = await import("../src/state.ts")

const reasons = Object.keys(BUILD_FAILURES) as (keyof typeof BUILD_FAILURES)[]
const retried = reasons.filter((r) => BUILD_FAILURES[r].retry !== null)

const ended = {
  origin: "owner" as const,
  kind: "site.build",
  lane: "full",
  retry_of: null,
  reason: "gates.repair_budget_exhausted",
  busy: false,
}

describe("whether a failed build is started again", () => {
  it.each(reasons)("follows the failure table for %s", (reason) => {
    expect(decide({ ...ended, reason })).toBe(
      BUILD_FAILURES[reason].retry === null ? "quiet" : "retry"
    )
  })

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
  })

  it("leaves a stop to the assistant while another build holds the site", () => {
    expect(decide({ ...ended, busy: true })).toBe("busy")
    expect(
      decide({ ...ended, busy: true, reason: "blueprint.undecided" })
    ).toBe("quiet")
  })
})

describe("what the owner reads", () => {
  const plan = fallbackBlueprint({ facts: [], recent: [] })
  const lines = [
    ...retried.flatMap((reason) => [
      retryingText("site.build", reason),
      retryingText("site.build", reason, true),
      stoppedText("site.revise", reason),
    ]),
    readyText("site.build", plan),
    readyText("site.revise", null),
    readyText("site.revise", null, { label: "your hero title" }),
    readyText(
      "site.revise",
      null,
      { label: "your hero title", words: "Professional home cleaning" },
      "b"
    ),
    readyText("site.revise", null, { label: "your hero title", nearest: true }),
    resumedText("site.build"),
    resumedText("site.revise"),
  ]

  it.each(lines)("%s", (line) => {
    // No code, id, number, name of ours or em dash.
    expect(line).not.toMatch(/[a-z]+[._][a-z]+|\d|Reme|Ava|—/)
    expect(line.length).toBeLessThan(240)
  })

  it("never claims a change the build made somewhere else instead", () => {
    const line = readyText(
      "site.revise",
      null,
      {
        label: "the small label above your hero title",
        words: "x",
        nearest: true,
      },
      "a"
    )
    expect(line).toBe(
      "I couldn't change the small label above your hero title exactly as you asked, so I made the nearest change I could. Have a look, and tell me if you'd like it done another way."
    )
  })

  it("names the open web address after the first draft by the journey's offer, and nothing once it is settled", () => {
    const line = (stage: AddressStageName) =>
      addressLine({ offer: offerOf(stage) })
    for (const stage of [
      "none",
      "unknown",
      "choosing",
      "buying_elsewhere",
    ] as const)
      expect(line(stage), stage).toBe(
        "When you'd like to set up your own address, tap Connect on the card."
      )
    expect(line("bought")).toBe(
      "When you're ready to connect your new address, tap Connect on the card."
    )
    for (const stage of [
      "put_off",
      "declined",
      "paying",
      "connecting",
      "live",
    ] as const)
      expect(line(stage), stage).toBe("")
    for (const stage of AddressStageName.options)
      expect(line(stage) !== "", stage).toBe(offerOf(stage) !== null)
  })

  it("says a change it could not make left the site as it was", () => {
    expect(stoppedText("site.revise", "change.refused")).toBe(
      "I couldn't make that change, so your site is as it was. Tell me more about what you'd like, or say try again."
    )
  })

  it("names the planned pages by the names the owner picked them by", () => {
    const pages = (ids: string[]) => ({
      ...plan,
      pages: ids.map((page) => ({ ...plan.pages[0], page })),
    })
    expect(readyText("site.build", pages(["home", "quote"]))).toBe(
      "Your draft is ready, with Home and Request a quote pages. Have a look below."
    )
    expect(
      readyText("site.build", pages(["home", "about", "service", "quote"]))
    ).toContain(
      "with Home, About and Request a quote pages, plus a page for each service."
    )
    expect(readyText("site.build", null)).toBe(
      "Your draft is ready. Have a look below."
    )
  })

  it("says what became of each page the owner picked that is a section", () => {
    const sections = {
      ...plan,
      pages: ["home", "quote"].map((page) => ({ ...plan.pages[0], page })),
      features: [
        ...plan.features.slice(0, 2),
        "Your FAQ is a section on the home page.",
        "Your reviews section is left out until you have a review to show. Send me one or two from your customers and I'll add it.",
      ],
    }
    expect(readyText("site.build", sections)).toBe(
      "Your draft is ready, with Home and Request a quote pages. Your FAQ is a section on the home page. Your reviews section is left out until you have a review to show. Send me one or two from your customers and I'll add it. Have a look below."
    )
  })
})

describe("a change's ready line", () => {
  const change = { label: "your hero title" }

  it("names the change, and quotes the new words of a copy change", () => {
    expect(readyText("site.revise", null, change, "c")).toBe(
      "I've updated your hero title. Have a look, and publish when you're happy."
    )
    expect(
      readyText("site.revise", null, { ...change, words: "Clean homes" }, "b")
    ).toBe(
      "I've updated your hero title: Clean homes. Have a look, and publish when you're happy."
    )
  })

  it("reads the same for the same change and varies between changes", () => {
    const line = (seed: string) => readyText("site.revise", null, change, seed)
    expect(line("a")).toBe(line("a"))
    expect(new Set(["a", "b", "c"].map(line)).size).toBeGreaterThan(1)
  })

  it("falls back to the plain line when there is no label", () => {
    expect(readyText("site.revise", null, {}, "a")).toMatch(
      /^Your changes are ready/
    )
  })
})

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)

/** The notes an assignment's steps wrote. */
const notesOf = (orgId: string, assignmentId: string) =>
  kit.withOrg({ orgId }, async (db) =>
    (
      await db
        .select({ payload: events.payload })
        .from(events)
        .where(
          sql`${events.assignmentId} = ${assignmentId} and ${events.type} = ${AGENT_NOTE}`
        )
        .orderBy(events.eventId)
    ).map((r) => r.payload)
  )

const SPENT = {
  model: "stand-in",
  cost_usd: 0.001,
  usage: { input_tokens: 200, output_tokens: 30 },
  ms: 5,
}
const writer = (text: string | Error) =>
  vi.fn<typeof writeText>(async () => {
    if (text instanceof Error) throw text
    return { text, spent: SPENT }
  })

live("a build note in the assistant's own voice", () => {
  const env = { OPENROUTER_API_KEY: "test-key" }
  const note = {
    kind: "retrying" as const,
    key: "site.retrying:x",
    assignment_id: crypto.randomUUID(),
    attempt: 1,
    of: 2,
    cause: "unfinished" as const,
    next: "retrying" as const,
    failed: ["claims" as const],
  }
  const good =
    "I ran into a problem checking your details while building the site, so I've started it again. Nothing for you to do, I'll say here when it's ready."

  it("uses the model's line when it passes, from structured fields only", async () => {
    const orgId = await freshOrg(kit)
    const write = writer(good)
    expect(
      await narrate(env, kit, orgId, "site.build", note, "template", write)
    ).toBe(good)
    const data = write.mock.calls[0]?.[2] as Record<string, unknown>
    expect(data).toMatchObject({
      event: "retrying",
      cause: "it stopped before the draft was done",
      checks_failed: ["checking every claim against your details"],
      draft: "template",
    })
    expect(
      await narrate(
        env,
        kit,
        orgId,
        "site.build",
        note,
        "template",
        writer("I hit a snag checking your details, so I've started it again.")
      )
    ).toBe("I hit a snag checking your details, so I've started it again.")
  })

  it("falls back to the template on a bad line, an error, no key or the hourly cap", async () => {
    const orgId = await freshOrg(kit)
    const bad = "Done — see https://x.test"
    expect(
      await narrate(env, kit, orgId, "site.build", note, "t", writer(bad))
    ).toBe("t")
    expect(
      await narrate(
        env,
        kit,
        orgId,
        "site.build",
        note,
        "t",
        writer(new Error("timeout"))
      )
    ).toBe("t")
    const unused = writer(good)
    expect(await narrate({}, kit, orgId, "site.build", note, "t", unused)).toBe(
      "t"
    )
    // The org's share of the hour, used up.
    await kit.withOrg({ orgId }, (db) =>
      db.insert(events).values(
        Array.from({ length: NARRATED_PER_HOUR }, () => ({
          eventId: newUlid(),
          orgId,
          staffId: null,
          assignmentId: null,
          type: "cos.background_step",
          occurredAt: new Date(),
          idempotencyKey: newUlid(),
          payload: { job: "build_note", outcome: "written" },
        }))
      )
    )
    expect(
      await narrate(env, kit, orgId, "site.build", note, "t", unused)
    ).toBe("t")
    expect(unused).not.toHaveBeenCalled()
  })

  it("falls back to the template without a call once the day's cap is spent", async () => {
    const orgId = await freshOrg(kit)
    await kit.withOrg({ orgId }, (db) =>
      db.insert(events).values({
        eventId: newUlid(),
        orgId,
        type: "cos.background_step",
        occurredAt: new Date(),
        idempotencyKey: newUlid(),
        payload: { job: "logo", cost_usd: DAILY_CAP_USD },
      })
    )
    const unused = writer(good)
    expect(
      await narrate(env, kit, orgId, "site.build", note, "t", unused)
    ).toBe("t")
    expect(unused).not.toHaveBeenCalled()
  })
})

afterAll(() => kit.close())

live("a failed owner build's retry", () => {
  const created: string[] = []
  const saved = new Set<string>()
  const env = {
    ASSIGNMENTS: {
      create: async ({ id }: { id: string }) => {
        created.push(id)
        return { id }
      },
    },
    SITES: { head: async (key: string) => (saved.has(key) ? {} : null) },
  } as unknown as Pick<Env, "ASSIGNMENTS" | "SITES">

  /** An owner's build with a plan whose photos were drawn, failed for `reason`. */
  async function failedBuild(
    orgId: string,
    reason: string,
    key: string,
    label?: string
  ) {
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
        ...(label ? { label } : {}),
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

  /** A change to the owner's unpublished draft, failed for `reason`, with the draft given back. */
  async function failedDraftChange(lane: "full" | "quick", reason: string) {
    const site = await previewed()
    await advance(kit, site.ids, "awaiting_review")
    const change = await kit.withOrg({ orgId: site.orgId }, async (db) => {
      const made = await insertAssignment(db, site.orgId, `k-${lane}`, true, {
        kind: "site.revise",
        goal: "Make the headline shorter.",
        model: "A",
        withhold: [],
        lane,
        change_kind: "copy",
        draft: site.revisionId,
      })
      if (!("row" in made)) throw new Error("not created")
      return made.row.id
    })
    const ids = await fail({ orgId: site.orgId, assignmentId: change }, reason)
    return { ...site, change: ids }
  }

  it("keeps the Try again pill when a change to a draft stops for good, and starts nothing", async () => {
    const site = await failedDraftChange(
      "quick",
      "gates.repair_budget_exhausted"
    )
    created.length = 0
    const first = await afterFailure(env, kit, site.change)
    expect(first).toEqual({
      retry_id: null,
      note: {
        key: `site.draft_back:${site.change.assignmentId}`,
        text: DRAFT_BACK,
        choices: tryAgain("site.revise"),
      },
    })
    expect(await afterFailure(env, kit, site.change)).toEqual(first)
    expect(created).toEqual([])
  })

  it("retries a full change to a draft from the same draft, then keeps the pill if it fails again", async () => {
    const site = await failedDraftChange(
      "full",
      "gates.repair_budget_exhausted"
    )
    created.length = 0
    const first = await afterFailure(env, kit, site.change)
    expect(first.retry_id).toEqual(created[0])
    expect(first.note?.key).toBe(`site.retrying:${site.change.assignmentId}`)
    expect(await afterFailure(env, kit, site.change)).toEqual(first)
    expect(created).toHaveLength(1)

    const [row] = await kit.withOrg({ orgId: site.orgId }, (db) =>
      db
        .select({ of: assignments.revisionOfAssignmentId })
        .from(assignments)
        .where(eq(assignments.id, first.retry_id as string))
    )
    expect(row?.of).toBe(site.ids.assignmentId)

    const retry = await fail(
      { orgId: site.orgId, assignmentId: first.retry_id as string },
      "developer.stalled"
    )
    expect(await afterFailure(env, kit, retry)).toEqual({
      retry_id: null,
      note: {
        key: `site.draft_back:${retry.assignmentId}`,
        text: DRAFT_BACK,
        choices: tryAgain("site.revise"),
      },
    })
    expect(created).toHaveLength(1)
  })

  it("asks for the assistant's turn when a build stops while another holds the site, and posts nothing itself", async () => {
    const orgId = await freshOrg(kit)
    const ids = await failedBuild(orgId, "gates.repair_budget_exhausted", "k-a")
    await kit.withOrg({ orgId }, (db) =>
      insertAssignment(db, orgId, "k-b", true, {
        kind: "site.build",
        goal: "Build the site again.",
        model: "A",
        withhold: [],
        lane: "full",
        change_kind: null,
      })
    )
    created.length = 0
    expect(await afterFailure(env, kit, ids)).toEqual({
      retry_id: null,
      note: null,
    })
    expect(created).toEqual([])
    expect(await notesOf(orgId, ids.assignmentId)).toEqual([
      expect.objectContaining({ kind: "stopped", next: "none" }),
    ])
    const wake = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ at: scheduledJobs.nextRunAt })
        .from(scheduledJobs)
        .where(sql`${scheduledJobs.kind} = 'cos_wake'`)
    )
    expect(wake).toHaveLength(1)
  })

  it("carries the change's label into its retry, so the ready line names it", async () => {
    const orgId = await freshOrg(kit)
    const ids = await failedBuild(
      orgId,
      "gates.repair_budget_exhausted",
      "k-label",
      "your hero title"
    )
    const { retry_id } = await afterFailure(env, kit, ids)
    const [made] = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ payload: events.payload })
        .from(events)
        .where(
          sql`${events.assignmentId} = ${retry_id} and ${events.type} = 'assignment.created'`
        )
    )
    expect(made?.payload).toMatchObject({ label: "your hero title" })
  })

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
        choices: [
          { label: "Try again", send: "Try building my website again." },
        ],
      },
    })
    expect(created).toHaveLength(1)

    // One note each, however often the step ran.
    expect(await notesOf(orgId, ids.assignmentId)).toEqual([
      {
        kind: "retrying",
        key: `site.retrying:${ids.assignmentId}`,
        assignment_id: ids.assignmentId,
        attempt: 1,
        of: 2,
        cause: "unfinished",
        next: "retrying",
        failed: [],
        retry_id: first.retry_id,
      },
    ])
    expect(await notesOf(orgId, retry.assignmentId)).toEqual([
      expect.objectContaining({
        kind: "stopped",
        attempt: 2,
        cause: "stalled",
        next: "waiting_owner",
      }),
    ])
  })

  it("keeps the drawn photos when the retry carries on from the kept site", async () => {
    const orgId = await freshOrg(kit)
    const ids = await failedBuild(orgId, "gates.failed", "k-kept")
    saved.add(workKey(ids))
    const { retry_id, note } = await afterFailure(env, kit, ids)
    expect(note?.text).toContain("fixing it from where it stopped")
    const [row] = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ blueprint: assignments.blueprint })
        .from(assignments)
        .where(eq(assignments.id, retry_id as string))
    )
    const plan = Blueprint.parse(row?.blueprint)
    expect(
      plan.images
        .filter((s) => s.source === "generated")
        .every((s) => s.asset_id)
    ).toBe(true)
  })

  it("leaves a build that waited on the owner as it ended, with a quiet note", async () => {
    const orgId = await freshOrg(kit)
    const ids = await failedBuild(orgId, "blueprint.undecided", "k2")
    expect(await afterFailure(env, kit, ids)).toEqual({
      retry_id: null,
      note: null,
    })
    expect(await notesOf(orgId, ids.assignmentId)).toEqual([
      expect.objectContaining({
        kind: "stopped",
        cause: "unanswered",
        next: "none",
      }),
    ])
  })

  it("notes each repair round once, and a ready draft with its pages", async () => {
    const orgId = await freshOrg(kit)
    const made = await kit.withOrg({ orgId }, (db) =>
      insertAssignment(db, orgId, "k3", true, {
        kind: "site.build",
        goal: "Build the site from the canonical facts.",
        model: "A",
        withhold: [],
        lane: "full",
        change_kind: null,
      })
    )
    if (!("row" in made)) throw new Error("not created")
    const ids = { orgId, assignmentId: made.row.id }
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(assignments)
        .set({ blueprint: fallbackBlueprint({ facts: [], recent: [] }) })
        .where(eq(assignments.id, ids.assignmentId))
    )
    for (const to of [
      "briefing",
      "planning",
      "implementing",
      "validating",
      "repairing",
    ] as const) {
      await advance(kit, ids, to)
    }
    const failed = [{ gate: "claims" as const }, { gate: "claims" as const }]
    await noteProblem(kit, ids, failed)
    await noteProblem(kit, ids, failed)
    const [problem] = await notesOf(orgId, ids.assignmentId)
    expect(problem).toMatchObject({
      kind: "problem",
      attempt: 1,
      of: 3,
      next: "repairing",
      failed: ["claims"],
    })

    // Not in review: no note, no line.
    expect(await readyNote(kit, ids)).toBeNull()
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(assignments)
        .set({ state: "awaiting_review" })
        .where(eq(assignments.id, ids.assignmentId))
    )
    const ready = await readyNote(kit, ids)
    await readyNote(kit, ids)
    expect(ready?.key).toBe(`site.ready:${ids.assignmentId}`)
    expect(ready?.text).toMatch(
      /^Your draft is ready, with .* When you'd like to set up your own address, tap Connect on the card\.$/
    )
    const done = (await notesOf(orgId, ids.assignmentId)).filter(
      (n) => n.kind === "done"
    )
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ next: "waiting_owner", attempt: 1 })
    expect(done[0]?.pages).toEqual(expect.arrayContaining(["Home"]))
  })

  it("asks nothing with the ready line, whatever the build left out", async () => {
    const orgId = await freshOrg(kit)
    const ids = await newAssignment(kit, orgId)
    const ask = (field: string, question: string) => ({
      field,
      question,
      answer_schema: { type: "string" },
      options: null,
    })
    await kit.withOrg({ orgId }, async (db) => {
      await supersedeFact(db, {
        orgId,
        key: "business.parking",
        factType: "business",
        value: "Street parking",
        provenance: { source: "owner_stated", confidence: 1 },
      })
      await appendEvent(db, {
        orgId,
        assignmentId: ids.assignmentId,
        staffId: null,
        type: "assignment.completion_reported",
        payload: {
          report_id: crypto.randomUUID(),
          org_id: orgId,
          assignment_id: ids.assignmentId,
          session_id: crypto.randomUUID(),
          revision_id: crypto.randomUUID(),
          summary: "Built the site.",
          changes: [{ path: "src/pages/index.astro", reason: "Home page" }],
          screenshots: [],
          checks: [{ check: "astro build", exit_code: 0, output_key: null }],
          risks: [],
          decisions_needed: [],
          left_out: [
            ask("business.insurance", "Are you insured, and for how much?"),
            ask("business.insurance", "What insurance do you hold?"),
            // Known since the build started: nothing to offer.
            ask("business.parking", "Can customers park near you?"),
            // Never put to the owner: it names a field.
            ask("business.guarantee", "What is business.guarantee?"),
            // The assistant's to ask once its work needs it, not a draft's.
            ask(
              "hours.weekday",
              "What days and hours are you open for calls and enquiries?"
            ),
          ],
          reported_at: new Date().toISOString(),
        },
      })
      await db
        .update(assignments)
        .set({ state: "awaiting_review" })
        .where(eq(assignments.id, ids.assignmentId))
    })
    const ready = await readyNote(kit, ids)
    expect(ready).toEqual({
      key: `site.ready:${ids.assignmentId}`,
      text: expect.stringMatching(/^Your draft is ready/),
    })
    expect(ready?.text).not.toMatch(/left out|Want me to add/)
  })

  it("notes every mid-build resume once, and says only a stall in the chat", async () => {
    const orgId = await freshOrg(kit)
    const made = await kit.withOrg({ orgId }, (db) =>
      insertAssignment(db, orgId, "k4", true, {
        kind: "site.build",
        goal: "Build the site from the canonical facts.",
        model: "A",
        withhold: [],
        lane: "full",
        change_kind: null,
      })
    )
    if (!("row" in made)) throw new Error("not created")
    const ids = { orgId, assignmentId: made.row.id }
    const resume = (attempt: number, reason: string) =>
      noteResumed({}, kit, ids, { attempt, of: 2, reason })

    // A replaced sandbox is over before the owner could notice.
    expect(await resume(1, "sandbox.updating")).toBeNull()
    // A stall is said; this org has no conversation to say it in.
    expect(await resume(2, "developer.stalled")).toBe("none")
    expect(await resume(2, "developer.stalled")).toBe("none")
    // A second stall says nothing new.
    expect(await resume(3, "developer.stalled")).toBeNull()
    expect(await notesOf(orgId, ids.assignmentId)).toEqual([
      expect.objectContaining({
        kind: "resumed",
        attempt: 1,
        cause: "service",
      }),
      expect.objectContaining({
        kind: "resumed",
        attempt: 2,
        of: 2,
        cause: "stalled",
        next: "retrying",
      }),
      expect.objectContaining({ kind: "resumed", attempt: 3 }),
    ])
  })
})

live("a build note's kind in the chat", () => {
  it("posts a ready draft as done, a stop or a draft given back as a note, and the rest as updates", async () => {
    const orgId = await freshOrg(kit)
    await openChat(kit, orgId)
    const id = crypto.randomUUID()
    for (const key of ["ready", "stopped", "draft_back", "retrying"])
      await postNote(kit, orgId, { key: `site.${key}:${id}`, text: key })
    const rows = await kit.withOrg({ orgId }, (db) =>
      db.execute<{ text: string; kind: string }>(sql`
        select p->>'text' as text, (select k->>'data' from jsonb_array_elements(content->'parts') k where k->>'type' = 'data-kind') as kind
        from conversation_messages, jsonb_array_elements(content->'parts') p
        where p->>'type' = 'text' order by seq`)
    )
    expect([...rows].map((r) => [r.text, r.kind])).toEqual([
      ["ready", "done"],
      ["stopped", "note"],
      ["draft_back", "note"],
      ["retrying", "update"],
    ])
  })
})
