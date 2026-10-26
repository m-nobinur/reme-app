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
  type Settled,
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

const STAGE_IDS = [
  "planning",
  "photos",
  "writing",
  "polishing",
  "checking",
  "ready",
]

/** What a build is doing, in the words the rows carry; a repair is the line under the checks. */
const stepOn = (rows: BuildActivity[]) => {
  const now = rows.find((r) => r.now)
  const repair = now?.id === "checking" && now.items?.some((i) => !i.done)
  return repair ? "fixing" : now?.label
}

describe("build activity rows", () => {
  it("lists every stage, earlier ones done and later ones not started", () => {
    const rows = activityFor("full", "implementing")
    expect(rows.map((r) => [r.id, r.done])).toEqual([
      ["planning", 1],
      ["photos", 0],
      ["writing", 0],
      ["polishing", 0],
      ["checking", 0],
      ["ready", 0],
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
      ["polishing", 0, 1],
      ["checking", 0, 1],
      ["ready", 0, 1],
    ])
    for (const row of writing) BuildActivity.parse(row)
    const checking = activityFor("full", "validating", progress)
    expect(checking.map((r) => [r.id, r.done, r.total])).toEqual([
      ["planning", 1, 1],
      ["photos", 7, 7],
      ["writing", 5, 5],
      ["polishing", 0, 1],
      ["checking", 0, 1],
      ["ready", 0, 1],
    ])
    // No plan means no design look, so polish does not apply.
    expect(checking.find((r) => r.id === "polishing")?.skipped).toBe(true)
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
    const planning = activityFor("full", "planning", {}, { plan })
    expect(planning.map((r) => r.id)).toEqual(STAGE_IDS)
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

  it("shows every page whose writer has started as at work until it is written, and only while writing", () => {
    const plan = Blueprint.parse(PLAN)
    const [first, second] = plan.pages.map((p) => p.page)
    const settled: Settled[] = [
      { stage: "pages", item: first as string, working: true },
      { stage: "pages", item: second as string, working: true },
      { stage: "pages", item: first as string },
    ]
    const pages = (state: AssignmentState) =>
      activityFor(
        "full",
        state,
        { pages: { done: 1, total: plan.pages.length } },
        { plan, settled }
      ).find((r) => r.id === "writing")?.items
    expect(pages("implementing")).toEqual([
      { label: expect.any(String), done: true },
      { label: expect.any(String), done: false, working: true },
    ])
    // Waiting on the owner, nothing is being written.
    expect(pages("blocked_on_information")?.some((i) => i.working)).toBe(false)
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
      expect(rows.map((r) => r.id)).toEqual(STAGE_IDS)
      return stepOn(rows)
    }
    const reported = { type: "assignment.completion_reported" }
    const asked = { type: "design.critiqued", fixes: 2 }
    const repairing = { type: "assignment.state_changed" }
    const WRITING = "Writing the pages"
    const LOOKING = "Looking over the design"
    const POLISHING = "Polishing the design"
    const CHECKING = "Checking the site"
    expect(at("implementing", [])).toBe(WRITING)
    // The lead's report ends the pages and starts the look; if the look asks
    // for changes the lead polishes until it reports again, and then it is checking.
    expect(at("implementing", [reported])).toBe(LOOKING)
    expect(at("implementing", [reported, asked])).toBe(POLISHING)
    expect(at("implementing", [reported, asked, reported])).toBe(CHECKING)
    // A look that asked for nothing, did not run, or was checked is over.
    expect(
      at("implementing", [reported, { type: "design.critiqued", fixes: 0 }])
    ).toBe(CHECKING)
    expect(
      at("implementing", [reported, { type: "design.critiqued", fixes: null }])
    ).toBe(CHECKING)
    expect(
      at("implementing", [
        reported,
        asked,
        reported,
        { type: "design.rechecked", fixes: 1 },
      ])
    ).toBe(CHECKING)
    expect(at("validating", [reported])).toBe(CHECKING)
    // The gates send it back to the lead, who is `implementing` again at once.
    const looked = [reported, { type: "design.critiqued", fixes: 0 }]
    expect(at("implementing", [...looked, repairing])).toBe("fixing")
    expect(at("repairing", looked)).toBe("fixing")
    expect(at("implementing", [...looked, repairing, reported])).toBe(CHECKING)
    // A repair is a line under the checks, not a row of its own, and it
    // stays, done, once the lead has reported again.
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
      ["polishing", true],
      ["checking", false],
      ["ready", false],
    ])
    expect(rows.find((r) => r.id === "checking")?.items).toEqual([
      { label: "Fixing what the checks found", done: true },
    ])
    // With the checks' report, the line counts what failed.
    const validated = { type: "assignment.validation_reported", fixes: 2 }
    expect(
      activityFor(
        "full",
        "repairing",
        {},
        { plan, marks: [reported, asked, reported, validated, repairing] }
      ).find((r) => r.id === "checking")?.items
    ).toEqual([{ label: "Fixing 2 things the checks found", done: false }])
    // Pages tick together when the lead wrote them itself.
    expect(
      activityFor("full", "implementing", {}, { plan, marks: [reported] })
        .find((r) => r.id === "writing")
        ?.items?.map((i) => i.done)
    ).toEqual([true, true])
    // No plan, no look, no photos: the report goes straight to the checks,
    // and the two stages that do not apply stay in the list, skipped.
    const unplanned = activityFor(
      "full",
      "implementing",
      {},
      { marks: [reported] }
    )
    expect(unplanned.map((r) => [r.id, r.skipped ?? false])).toEqual([
      ["planning", false],
      ["photos", true],
      ["writing", false],
      ["polishing", true],
      ["checking", false],
      ["ready", false],
    ])
    expect(stepOn(unplanned)).toBe("Checking the site")
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
    const sequence: [string, AssignmentState, Mark[], string][] = [
      // The lead reported at 09:06:58, the critic read the screens until 09:07:24.
      ["09:06:58", "implementing", [R], "Looking over the design"],
      // Five fixes asked; the lead made three of them until 09:08:06.
      ["09:07:24", "implementing", [R, critiqued], "Polishing the design"],
      // Reported again: the recheck, the screenshots and axe, then the gates.
      ["09:08:06", "implementing", [R, critiqued, R], "Checking the site"],
      [
        "09:08:24",
        "implementing",
        [R, critiqued, R, rechecked],
        "Checking the site",
      ],
      [
        "09:08:25.1",
        "validating",
        [R, critiqued, R, rechecked],
        "Checking the site",
      ],
      // The copy gate failed: back to the lead at once, for 24 s.
      [
        "09:08:25.3",
        "implementing",
        [R, critiqued, R, rechecked, repaired],
        "fixing",
      ],
      [
        "09:08:49.3",
        "validating",
        [R, critiqued, R, rechecked, repaired, R],
        "Checking the site",
      ],
      [
        "09:08:59.5",
        "implementing",
        [R, critiqued, R, rechecked, repaired, R, repaired],
        "fixing",
      ],
      [
        "09:09:57.8",
        "validating",
        [R, critiqued, R, rechecked, repaired, R, repaired, R],
        "Checking the site",
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
      expect(stepOn(rows), at).toBe(now)
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
    expect(brief.map((r) => [r.id, r.done === r.total]).slice(-3)).toEqual([
      ["polishing", true],
      ["checking", false],
      ["ready", false],
    ])
    expect(stepOn(brief)).toBe("fixing")
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
    expect(now([])).toEqual([["writing", "Putting the site together", 2, 2]])
    expect(
      rows([])
        .find((r) => r.id === "writing")
        ?.items?.every((i) => i.done)
    ).toBe(true)
    expect(now([{ type: "assignment.completion_reported" }])).toEqual([
      ["polishing", "Looking over the design", 0, 1],
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

  it("shows none for a build that ended unfinished", () => {
    expect(activityFor("full", "failed")).toEqual([])
    expect(activityFor("full", "cancelled")).toEqual([])
  })

  it("follows a quick change through the steps its own events told", () => {
    const rows = (state: AssignmentState, step?: string, marks: Mark[] = []) =>
      activityFor("quick", state, {}, { step, marks }).map(
        (r) => `${r.id}:${r.done}${r.now ? ":now" : ""}`
      )
    expect(rows("queued")).toEqual(["edit:0", "check:0", "preview:0"])
    expect(rows("implementing", "edit")).toEqual([
      "edit:0:now",
      "check:0",
      "preview:0",
    ])
    expect(rows("implementing", "check")).toEqual([
      "edit:1",
      "check:0:now",
      "preview:0",
    ])
    expect(rows("validating", "preview")).toEqual([
      "edit:1",
      "check:1",
      "preview:0:now",
    ])
    expect(rows("awaiting_review", "preview")).toEqual([
      "edit:1",
      "check:1",
      "preview:1",
    ])
    // The Developer's section change tells no step: its report is the preview.
    expect(rows("implementing")).toEqual(["edit:0:now", "check:0", "preview:0"])
    const reported: Mark[] = [{ type: "assignment.completion_reported" }]
    expect(rows("implementing", undefined, reported)).toEqual([
      "edit:1",
      "check:1",
      "preview:0:now",
    ])
  })

  it("lists every stage before the build starts, and keeps them all once it is ready", () => {
    const queued = activityFor("full", "queued")
    expect(queued.map((r) => r.id)).toEqual(STAGE_IDS)
    expect(queued.some((r) => r.now || r.done)).toBe(false)
    const plan = Blueprint.parse(PLAN)
    const ready = activityFor("full", "preview_ready", {}, { plan })
    expect(ready.map((r) => r.id)).toEqual(STAGE_IDS)
    expect(ready.every((r) => r.done === r.total || r.skipped)).toBe(true)
    expect(ready.some((r) => r.now)).toBe(false)
    expect(ready.find((r) => r.id === "ready")?.done).toBe(1)
    for (const row of [...queued, ...ready]) BuildActivity.parse(row)
  })

  it("holds a build waiting on a person at the stage its events reached", () => {
    const wait = (progress: Progress, marks: Mark[]) =>
      stepOn(activityFor("full", "blocked_on_information", progress, { marks }))
    expect(wait({}, [])).toBe("Planning the layout")
    expect(wait({ pages: { done: 1, total: 3 } }, [])).toBe("Writing the pages")
    expect(wait({}, [{ type: "assignment.completion_reported" }])).toBe(
      "Checking the site"
    )
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

/** A seeded stream of numbers in [0, 1), so a failing build replays from its seed. */
function seeded(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Frame = {
  state: AssignmentState
  progress: Progress
  marks: Mark[]
  plan: Blueprint | null
  settled: Settled[]
}

/**
 * One build's events in the order they land, as the frames `readBuilds` would
 * read: it queues, plans, draws its photos, writes its pages, reports, is
 * looked over, is checked and repaired some times, and is ready. A build
 * waiting on a person may repeat a frame in a parked state.
 */
function lifecycle(rand: () => number): Frame[] {
  const planned = rand() < 0.8
  const slots = planned ? Math.floor(rand() * 4) : 0
  const plan = planned
    ? Blueprint.parse({
        ...PLAN,
        images: ["hero", "team", "about"].slice(0, slots).map((id) => ({
          ...SLOT,
          id,
          alt: id,
        })),
      })
    : null
  const frames: Frame[] = []
  const marks: Mark[] = []
  const progress: Progress = {}
  const settled: Settled[] = []
  const push = (state: AssignmentState, withPlan = true) => {
    const frame = {
      state,
      progress: structuredClone(progress),
      marks: [...marks],
      plan: withPlan ? plan : null,
      settled: [...settled],
    }
    frames.push(frame)
    // A parked build with nothing to place it by reads as planning (the
    // shortcut in `activityFor`), so the generator does not park one there.
    const placed =
      frame.plan ||
      frame.marks.length > 0 ||
      frame.progress.pages ||
      frame.progress.photos ||
      state === "queued" ||
      state === "briefing" ||
      state === "planning"
    if (placed && state !== "preview_ready" && rand() < 0.15)
      frames.push({ ...frame, state: "blocked_on_information" })
  }
  const reported = { type: "assignment.completion_reported" }
  push("queued", false)
  push("briefing", false)
  push("planning")
  push("implementing")
  for (let done = 1; done <= slots; done++) {
    progress.photos = { done, total: slots }
    push("implementing")
  }
  const pages = 1 + Math.floor(rand() * 2)
  for (let done = 1; done <= pages; done++) {
    progress.pages = { done, total: pages }
    settled.push({ stage: "pages", item: done === 1 ? "home" : "services" })
    push("implementing")
  }
  marks.push(reported)
  push("implementing")
  if (planned) {
    const fixes = rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 4)
    marks.push({ type: "design.critiqued", fixes })
    push("implementing")
    if (fixes) {
      marks.push(reported)
      push("implementing")
    }
  }
  push("validating")
  for (let round = Math.floor(rand() * 3); round > 0; round--) {
    marks.push({ type: "assignment.state_changed" })
    push("repairing")
    push("implementing")
    marks.push(reported)
    push("validating")
  }
  push("preview_ready")
  return frames
}

describe("build activity over a whole build", () => {
  it("lists the same stages from the first event, and the done count never falls", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const frames = lifecycle(seeded(seed))
      const rows = frames.map((f) =>
        activityFor("full", f.state, f.progress, f)
      )
      let settledBefore = new Set<string>()
      let doneBefore = new Set<string>()
      let stageBefore = -1
      rows.forEach((frame, i) => {
        const at = `seed ${seed}, frame ${i} (${frames[i]?.state})`
        expect(
          frame.map((r) => r.id),
          at
        ).toEqual(STAGE_IDS)
        for (const row of frame) BuildActivity.parse(row)
        const done = new Set(
          frame.filter((r) => !r.skipped && r.done === r.total).map((r) => r.id)
        )
        const settled = new Set(
          frame.filter((r) => r.skipped || r.done === r.total).map((r) => r.id)
        )
        // Nothing done is undone, and a skipped stage stays settled.
        for (const id of doneBefore)
          expect(done.has(id), `${at}: ${id}`).toBe(true)
        for (const id of settledBefore)
          expect(settled.has(id), `${at}: ${id}`).toBe(true)
        // At most one stage is under way, and never an earlier one than before.
        const now = frame.filter((r) => r.now).map((r) => r.id)
        expect(now.length, at).toBeLessThanOrEqual(1)
        const stage = now[0] ? STAGE_IDS.indexOf(now[0]) : stageBefore
        expect(stage, at).toBeGreaterThanOrEqual(stageBefore)
        doneBefore = done
        settledBefore = settled
        stageBefore = stage
      })
      // Ready keeps every row; only the photos and the polish may be skipped.
      const last = rows.at(-1) ?? []
      expect(last.every((r) => r.skipped || r.done === r.total)).toBe(true)
      expect(
        last.filter((r) => r.skipped).map((r) => r.id),
        `seed ${seed}`
      ).toSatisfy((ids: string[]) =>
        ids.every((id) => id === "photos" || id === "polishing")
      )
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
    blueprint: plan,
    proposed: { round: 2, previous: plan },
  }

  it("carries the plan, its round and the plan it changed", () => {
    expect(planOf(row).blueprint).toEqual({
      plan,
      round: 2,
      previous: plan,
    })
    expect(planOf({ ...row, proposed: { round: 1 } }).blueprint).toMatchObject({
      round: 1,
      previous: null,
    })
  })

  it("leaves out a build with no plan, or one that no longer parses", () => {
    expect(planOf({ ...row, blueprint: null, proposed: null })).toEqual({})
    expect(planOf({ ...row, blueprint: { direction: "x" } })).toEqual({})
  })
})
