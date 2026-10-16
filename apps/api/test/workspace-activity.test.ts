import {
  type AssignmentState,
  Blueprint,
  BUILD_ACTIVITY_MAX,
  BuildActivity,
  BuildPhoto,
  PAGES,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  activityFor,
  causeOf,
  EXPECTED_SECONDS,
  type Mark,
  type Progress,
  photosOf,
  planOf,
} from "../src/workspace.ts"

const HERO = {
  kind: "hero",
  variant: "wash",
  purpose: "Lead",
  content_notes: null,
}

/** A generated slot still to draw. */
const SLOT = {
  page: "home",
  section: "hero",
  aspect: "16:9",
  resolution: "1K",
  subject: "A clean kitchen",
  source: "generated",
} as const

/** A two-page plan that makes one photo. */
const PLAN = {
  direction: "calm_daylight",
  fonts: "outfit_figtree",
  palette: { kind: "preset", id: "forest" },
  pages: [
    { page: "home", sections: [HERO] },
    { page: "services", sections: [HERO] },
  ],
  images: [{ ...SLOT, id: "hero", alt: "A kitchen" }],
  voice: "Warm and plain.",
  features: ["One", "Two", "Three", "Four"],
}

describe("build activity rows", () => {
  it("lists every stage, earlier ones done and later ones not started", () => {
    const rows = activityFor("full", "implementing")
    expect(rows.map((r) => [r.id, r.done])).toEqual([
      ["planning", 1],
      ["writing", 0],
      ["checking", 0],
    ])
    for (const row of rows) BuildActivity.parse(row)
  })

  it("counts a planned build's photos and pages, and fills a stage it passed", () => {
    const progress = {
      photos: { done: 4, total: 7 },
      pages: { done: 3, total: 5 },
    }
    const writing = activityFor("full", "implementing", progress)
    expect(writing.map((r) => [r.id, r.done, r.total])).toEqual([
      ["planning", 1, 1],
      ["photos", 4, 7],
      ["writing", 3, 5],
      ["checking", 0, 1],
    ])
    for (const row of writing) BuildActivity.parse(row)
    const checking = activityFor("full", "validating", progress)
    expect(checking.map((r) => [r.id, r.done, r.total])).toEqual([
      ["planning", 1, 1],
      ["photos", 7, 7],
      ["writing", 5, 5],
      ["checking", 0, 1],
    ])
  })

  it("makes the photos the current step with a live count while slots settle", () => {
    const current = (progress: Progress) =>
      activityFor("full", "implementing", progress).find((r) => r.now)
    expect(current({ photos: { done: 0, total: 7 } })).toMatchObject({
      id: "photos",
      done: 0,
      total: 7,
    })
    expect(current({ photos: { done: 5, total: 7 } })).toMatchObject({
      id: "photos",
      done: 5,
    })
    // Every slot settled, or a page already written: the pages are the step.
    expect(current({ photos: { done: 7, total: 7 } })?.id).toBe("writing")
    expect(
      current({ photos: { done: 5, total: 7 }, pages: { done: 1, total: 5 } })
        ?.id
    ).toBe("writing")
    // A build with no photos has nothing to draw first.
    expect(current({})?.id).toBe("writing")
  })

  it("names a plan's pages as they are written, and adds its photos and the design look", () => {
    const plan = Blueprint.parse(PLAN)
    const generated = plan.images.filter((i) => i.source === "generated")
    const planning = activityFor("full", "planning", {}, { plan })
    expect(planning.map((r) => r.id)).toEqual([
      "planning",
      ...(generated.length ? ["photos"] : []),
      "writing",
      "assembling",
      "design",
      "checking",
    ])
    expect(planning.length).toBeLessThanOrEqual(BUILD_ACTIVITY_MAX)
    const [first] = plan.pages
    const rows = activityFor(
      "full",
      "implementing",
      { pages: { done: 1, total: plan.pages.length } },
      { plan, settled: [{ stage: "pages", item: first?.page as string }] }
    )
    for (const row of rows) BuildActivity.parse(row)
    const items = rows.find((r) => r.id === "writing")?.items ?? []
    expect(items.map((i) => i.done)).toEqual(plan.pages.map((_, i) => i === 0))
    expect(items[0]?.label).toBe(PAGES.find((p) => p.id === first?.page)?.label)
  })

  it("follows the build's events past the pages: the look, the checks, a repair", () => {
    const plan = Blueprint.parse(PLAN)
    const at = (state: AssignmentState, marks: Mark[]) => {
      const rows = activityFor(
        "full",
        state,
        { photos: { done: 1, total: 1 } },
        { plan, marks }
      )
      for (const row of rows) BuildActivity.parse(row)
      expect(rows.length).toBeLessThanOrEqual(BUILD_ACTIVITY_MAX)
      return rows.find((r) => r.done < r.total)?.id
    }
    const reported = { type: "assignment.completion_reported" }
    const asked = { type: "design.critiqued", fixes: 2 }
    const repairing = { type: "assignment.state_changed" }
    expect(at("implementing", [])).toBe("writing")
    // The lead's report ends the pages and starts the look; if the look asks
    // for changes the lead polishes until it reports again, and then it is checking.
    expect(at("implementing", [reported])).toBe("design")
    expect(at("implementing", [reported, asked])).toBe("polishing")
    expect(at("implementing", [reported, asked, reported])).toBe("checking")
    // A look that asked for nothing, did not run, or was checked is over.
    expect(
      at("implementing", [reported, { type: "design.critiqued", fixes: 0 }])
    ).toBe("checking")
    expect(
      at("implementing", [reported, { type: "design.critiqued", fixes: null }])
    ).toBe("checking")
    expect(
      at("implementing", [
        reported,
        asked,
        reported,
        { type: "design.rechecked", fixes: 1 },
      ])
    ).toBe("checking")
    expect(at("validating", [reported])).toBe("checking")
    // The gates send it back to the lead, who is `implementing` again at once.
    const looked = [reported, { type: "design.critiqued", fixes: 0 }]
    expect(at("implementing", [...looked, repairing])).toBe("fixing")
    expect(at("repairing", looked)).toBe("fixing")
    expect(at("implementing", [...looked, repairing, reported])).toBe(
      "checking"
    )
    // The polish and repair rows stay once there has been one, done, before the checks.
    const rows = activityFor(
      "full",
      "validating",
      {},
      { plan, marks: [reported, asked, reported, repairing, reported] }
    )
    expect(rows.map((r) => [r.id, r.done === r.total])).toEqual([
      ["planning", true],
      ["photos", true],
      ["writing", true],
      ["assembling", true],
      ["design", true],
      ["polishing", true],
      ["fixing", true],
      ["checking", false],
    ])
    expect(rows.length).toBe(BUILD_ACTIVITY_MAX)
    // Pages tick together when the lead wrote them itself.
    expect(
      activityFor("full", "implementing", {}, { plan, marks: [reported] })
        .find((r) => r.id === "writing")
        ?.items?.map((i) => i.done)
    ).toEqual([true, true])
    // No plan, no look: the report goes straight to the checks.
    expect(
      activityFor("full", "implementing", {}, { marks: [reported] }).map(
        (r) => r.id
      )
    ).toEqual(["planning", "writing", "checking"])
  })

  // Perf run 3: the panel held "Looking over the design" from the lead's report
  // to the preview, though the critic, the lead's fix round, two gate rounds
  // and the checks all ran in that time. These are that build's events in
  // order (state, and the marks readBuilds selects), with the time each landed.
  it("shows each step of perf run 3's late build while it runs, and every one it passed", () => {
    const plan = Blueprint.parse(PLAN)
    const R = { type: "assignment.completion_reported" }
    const critiqued = { type: "design.critiqued", fixes: 5 }
    const rechecked = { type: "design.rechecked", fixes: 5 }
    const repaired = { type: "assignment.state_changed" }
    const sequence: [string, AssignmentState, Mark[], string[]][] = [
      // The lead reported at 09:06:58, the critic read the screens until 09:07:24.
      ["09:06:58", "implementing", [R], ["design"]],
      // Five fixes asked; the lead made three of them until 09:08:06.
      ["09:07:24", "implementing", [R, critiqued], ["polishing"]],
      // Reported again: the recheck, the screenshots and axe, then the gates.
      ["09:08:06", "implementing", [R, critiqued, R], ["checking"]],
      ["09:08:24", "implementing", [R, critiqued, R, rechecked], ["checking"]],
      ["09:08:25.1", "validating", [R, critiqued, R, rechecked], ["checking"]],
      // The copy gate failed: back to the lead at once, for 24 s.
      [
        "09:08:25.3",
        "implementing",
        [R, critiqued, R, rechecked, repaired],
        ["fixing"],
      ],
      [
        "09:08:49.3",
        "validating",
        [R, critiqued, R, rechecked, repaired, R],
        ["checking"],
      ],
      [
        "09:08:59.5",
        "implementing",
        [R, critiqued, R, rechecked, repaired, R, repaired],
        ["fixing"],
      ],
      [
        "09:09:57.8",
        "validating",
        [R, critiqued, R, rechecked, repaired, R, repaired, R],
        ["checking"],
      ],
    ]
    for (const [at, state, marks, now] of sequence) {
      const rows = activityFor(
        "full",
        state,
        { photos: { done: 8, total: 8 }, pages: { done: 6, total: 6 } },
        { plan, marks }
      )
      for (const row of rows) BuildActivity.parse(row)
      expect(
        rows.filter((r) => r.now).map((r) => r.id),
        at
      ).toEqual(now)
      // Whatever it is on, every step before it in the order reads as done.
      const here = rows.findIndex((r) => r.now)
      expect(
        rows.slice(0, here).every((r) => r.done === r.total),
        at
      ).toBe(true)
    }
    // A step that ran for under a second is still on the list, done.
    const brief = activityFor(
      "full",
      "implementing",
      {},
      { plan, marks: [R, critiqued, R, rechecked, repaired] }
    )
    expect(brief.map((r) => [r.id, r.done === r.total]).slice(-4)).toEqual([
      ["design", true],
      ["polishing", true],
      ["fixing", false],
      ["checking", false],
    ])
  })

  // Perf run 2 sat on "Writing the pages 6 of 6" for 2 min 20 s while the
  // lead put the site together.
  it("puts the site together once every page is written, until a report is accepted", () => {
    const plan = Blueprint.parse(PLAN)
    const rows = (marks: Mark[], done = 2) =>
      activityFor(
        "full",
        "implementing",
        { pages: { done, total: 2 } },
        { plan, marks }
      )
    const now = (marks: Mark[], done?: number) =>
      rows(marks, done)
        .filter((r) => r.now)
        .map((r) => [r.id, r.label, r.done, r.total])
    expect(now([], 1)).toEqual([["writing", "Writing the pages", 1, 2]])
    // Both pages counted and the lead's report refused, or not yet made.
    expect(now([])).toEqual([["assembling", "Putting the site together", 0, 1]])
    expect(
      rows([])
        .find((r) => r.id === "writing")
        ?.items?.every((i) => i.done)
    ).toBe(true)
    expect(now([{ type: "assignment.completion_reported" }])).toEqual([
      ["design", "Looking over the design", 0, 1],
    ])
    for (const row of rows([])) BuildActivity.parse(row)
  })

  it("names why a build stopped from the Workflow's reason, other when it has no words", () => {
    expect(causeOf("developer.stalled")).toBe("stalled")
    expect(causeOf("developer.no_report")).toBe("unfinished")
    expect(causeOf("information.unanswered")).toBe("unanswered")
    expect(causeOf("provider.unavailable")).toBe("service")
    expect(causeOf("something.new")).toBe("other")
    expect(causeOf(null)).toBe("other")
  })

  it("shows none for a quick build or a state outside the stages", () => {
    expect(activityFor("quick", "implementing")).toEqual([])
    expect(activityFor("full", "blocked_on_information")).toEqual([])
  })

  it("lists the photos as they settle, then those still drawing", () => {
    const plan = Blueprint.parse({
      ...PLAN,
      images: [
        { ...SLOT, id: "hero", alt: "The van" },
        { ...SLOT, id: "team", alt: "The team" },
        { ...SLOT, id: "about", alt: "The office" },
      ],
    })
    const id = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"
    const photos = photosOf(plan, [
      { stage: "photos", item: "team", status: "generated", asset_id: id },
      { stage: "photos", item: "team", status: "generated", asset_id: id },
      { stage: "photos", item: "gone", status: "fallback", asset_id: null },
      { stage: "pages", item: "home" },
    ])
    expect(photos).toEqual([
      {
        slot_id: "team",
        state: "made",
        alt: "The team",
        thumbnail: `/api/photos/${id}`,
      },
      { slot_id: "gone", state: "fallback", alt: null, thumbnail: null },
      { slot_id: "hero", state: "drawing", alt: "The van", thumbnail: null },
      {
        slot_id: "about",
        state: "drawing",
        alt: "The office",
        thumbnail: null,
      },
    ])
    for (const photo of photos) BuildPhoto.parse(photo)
  })

  it("keeps p50 under p95 per lane", () => {
    for (const lane of Object.values(EXPECTED_SECONDS)) {
      expect(lane.p50).toBeLessThan(lane.p95)
    }
  })
})

describe("a build's Blueprint on the frame", () => {
  const plan = {
    direction: "calm_daylight",
    fonts: "outfit_figtree",
    palette: { kind: "preset", id: "forest" },
    pages: [
      {
        page: "home",
        sections: [
          {
            kind: "hero",
            variant: "wash",
            purpose: "Lead",
            content_notes: null,
          },
        ],
      },
    ],
    images: [],
    voice: "Warm and plain.",
    features: ["One", "Two", "Three", "Four"],
  }
  const row = {
    state: "planning" as const,
    blueprint: plan,
    proposed: { round: 2, review: true, previous: plan },
    decidedRound: 1,
  }

  it("waits on the owner until the round is decided", () => {
    expect(planOf(row).blueprint).toMatchObject({
      round: 2,
      awaiting: true,
      previous: plan,
    })
    expect(planOf({ ...row, decidedRound: 2 }).blueprint?.awaiting).toBe(false)
    expect(
      planOf({ ...row, proposed: { round: 1, review: false } }).blueprint
    ).toMatchObject({ awaiting: false, previous: null })
    expect(planOf({ ...row, state: "implementing" }).blueprint?.awaiting).toBe(
      false
    )
  })

  it("leaves out a build with no plan, or one that no longer parses", () => {
    expect(planOf({ ...row, blueprint: null, proposed: null })).toEqual({})
    expect(planOf({ ...row, blueprint: { direction: "x" } })).toEqual({})
  })
})
