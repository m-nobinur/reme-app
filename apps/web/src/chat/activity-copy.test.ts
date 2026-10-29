import {
  type ActivitySegment,
  CosToolName,
  OnboardingStep,
  PLAN_FACT_KEYS,
  PlanNext,
} from "@workspace/contracts"
import {
  type BuildStage,
  changeAsked,
  cleanArg,
  elapsedText,
  type LineState,
  notStarted,
  onboardingLine,
  type PageActionKey,
  pageAction,
  pillLine,
  planningLine,
  proofOf,
  segmentLine,
  segmentTitle,
  stageLine,
  standingLine,
  toolLine,
  turnMoment,
  waitingLine,
  waitingRow,
  workLine,
  writingBack,
} from "@workspace/ui/lib/activity-copy"
import { describe, expect, it } from "vitest"

const words = (line: string) => line.split(/\s+/).length
const STAMP = "2026-10-22T10:00:00.000Z"
const DASH = /[–—]/
// A UUID, a run of 7 or more hex characters, a snake_case value or a staff code.
const INTERNAL =
  /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{7,}|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b[A-Z]{3}-\d{3}\b/i
const WORKING = /^[A-Z][a-z]+ing\b/
// A capital, or a domain name, which keeps its own case.
const STARTS = /^(?:[A-Z]|[a-z0-9-]+(?:\.[a-z0-9-]+)+\b)/
const DONE = /^(?:\w+ed|Found|Wrote|Made|Got|Reminder|Finished)\b/

/** What no line may hold, whatever the form. */
function plain(line: string | null) {
  expect(line).toBeTruthy()
  expect(line).not.toMatch(DASH)
  expect(line).not.toMatch(INTERNAL)
  expect(line).not.toMatch(/…/)
  expect(line).not.toMatch(/Reme/)
  expect(line).not.toMatch(/\.$/)
}

const ARGS = [
  {},
  {
    domain: "https://www.spark.mnobinur.dev/about?x=1",
    query: "cheap cleaning",
    when: "Friday, 9:00 am",
    count: 3,
  },
]

describe("a change asked for in the panel", () => {
  it("keeps their words and clips a long note", () => {
    expect(changeAsked("Bigger logo")).toBe("Asked for changes: Bigger logo")
    const long = changeAsked(
      "Make the hero say end of tenancy cleans. ".repeat(5)
    )
    expect(long.length).toBeLessThanOrEqual("Asked for changes: ".length + 100)
    expect(long).toMatch(/…$/)
    expect(changeAsked("Bigger logo — please")).not.toMatch(DASH)
  })
})

describe("tool lines", () => {
  for (const tool of CosToolName.options) {
    it(`${tool} reads right in all three forms`, () => {
      for (const args of ARGS) {
        const working = toolLine(tool, "working", args)
        plain(working)
        expect(working).toMatch(WORKING)
        expect(words(working)).toBeGreaterThanOrEqual(2)
        expect(words(working)).toBeLessThanOrEqual(6)
        const done = toolLine(tool, "done", args)
        plain(done)
        expect(done).toMatch(DONE)
        const failed = toolLine(tool, "failed", args)
        expect(failed).toMatch(/^Couldn't .+, try again in a moment$/)
        expect(failed).not.toMatch(DASH)
        expect(failed).not.toMatch(INTERNAL)
      }
    })
  }

  it("shows a domain, never a URL, and keeps the result", () => {
    const args = ARGS[1]
    expect(toolLine("check_domain", "working", args)).toBe(
      "Checking DNS for www.spark.mnobinur.dev"
    )
    expect(toolLine("create_reminder", "done", args)).toBe(
      "Reminder set for Friday, 9:00 am"
    )
    expect(toolLine("find_domain", "done", args)).toBe("Found 3 names")
    expect(toolLine("find_domain", "done", { count: 1 })).toBe("Found 1 name")
    expect(toolLine("find_domain", "done", { count: 0 })).toBe(
      "Found no free names"
    )
  })

  it("drops an id used as an argument and cleans the model's step", () => {
    expect(
      toolLine("find_domain", "working", {
        query: "0f8f8431-aaaa-bbbb-cccc-1234567890ab",
      })
    ).toBe("Searching for a domain")
    const step = toolLine("request_change", "working", {
      step: "  Adding   the new photos to the home page, then checking every page on the site ",
    })
    expect(step.length).toBeLessThanOrEqual(60)
    expect(step).toMatch(/^Adding the new photos/)
    expect(toolLine("request_change", "working")).toBe("Passing on your change")
  })
})

describe("build stage lines", () => {
  const stages: BuildStage[] = [
    "planning",
    "photos",
    "writing",
    "polishing",
    "checking",
    "ready",
  ]
  const counts = [{}, { done: 3, total: 8, fixes: 2 }]
  const forms: LineState[] = ["working", "done", "failed"]

  for (const stage of stages) {
    it(`${stage} reads right in all three forms`, () => {
      for (const args of counts) {
        const [working, done, failed] = forms.map((form) =>
          stageLine(stage, form, args)
        ) as [string, string, string]
        plain(working)
        // Pages part written say what is done and what is left.
        if (!(stage === "writing" && args.done)) {
          expect(working).toMatch(WORKING)
          expect(words(working)).toBeLessThanOrEqual(6)
        }
        expect(words(working)).toBeGreaterThanOrEqual(2)
        plain(done)
        expect(done).toMatch(DONE)
        expect(failed).toMatch(
          /^Couldn't [^,.]+\. You can try again from here\.$/
        )
      }
    })
  }

  it("says what stopped and offers a new try", () => {
    expect(stageLine("writing", "failed")).toBe(
      "Couldn't finish the pages. You can try again from here."
    )
  })

  it("carries the counts the orchestrator sends", () => {
    const args = { done: 3, total: 8, fixes: 2 }
    expect(stageLine("photos", "working", args)).toBe("Making 8 photos, 3 done")
    expect(stageLine("writing", "working", { done: 3, total: 6 })).toBe(
      "3 pages are done, 3 to go"
    )
    expect(stageLine("writing", "done", { total: 6 })).toBe("Wrote 6 pages")
    expect(stageLine("checking", "working")).toBe("Checking every page")
    expect(stageLine("checking", "working", args)).toBe(
      "Fixing 2 things the checks found"
    )
    expect(stageLine("checking", "working", { fixes: 1 })).toBe(
      "Fixing 1 thing the checks found"
    )
  })
})

describe("the pages as they are written", () => {
  const line = (args: Parameters<typeof stageLine>[2]) =>
    stageLine("writing", "working", args)

  it("follows the writers: alone, several at once, then done and left", () => {
    expect(line({})).toBe("Writing the pages")
    expect(line({ done: 0, total: 7 })).toBe("Writing 7 pages")
    expect(line({ done: 0, total: 7, working: 1 })).toBe("Writing 7 pages")
    expect(line({ done: 0, total: 7, working: 3 })).toBe(
      "Writing 3 pages at once"
    )
    expect(line({ done: 1, total: 7, written: ["Home"] })).toBe(
      "Home is done, 6 to go"
    )
    expect(line({ done: 2, total: 7, written: ["Home", "Services"] })).toBe(
      "Home and Services are done, 5 to go"
    )
    expect(
      line({ done: 3, total: 7, written: ["Home", "Services", "About"] })
    ).toBe("3 pages are done, 4 to go")
    expect(line({ done: 1, total: 7 })).toBe("1 page is done, 6 to go")
    expect(line({ done: 7, total: 7 })).toBe("Putting the pages together")
  })
})

describe("onboarding lines", () => {
  it("has a working line for every fact the planner can state", () => {
    for (const key of PLAN_FACT_KEYS) {
      const line = onboardingLine({ kind: "fact", key })
      plain(line)
      expect(line).toMatch(WORKING)
      expect(words(line)).toBeGreaterThanOrEqual(2)
      expect(words(line)).toBeLessThanOrEqual(6)
    }
  })

  it("has a working line for every move the planner can make", () => {
    for (const option of PlanNext.options) {
      const next = option.shape.kind.value
      // A reopened step is sent as the question it asks again.
      if (next === "reopen") continue
      const line = onboardingLine({ kind: "next", next })
      plain(line)
      expect(line).toMatch(WORKING)
      expect(words(line)).toBeLessThanOrEqual(6)
    }
    expect(onboardingLine({ kind: "fact", key: "business.offerings" })).toBe(
      "Noting your services"
    )
    expect(onboardingLine({ kind: "next", next: "review_quote_form" })).toBe(
      "Drafting your quote requirements"
    )
  })

  it("has a working line for every step a turn can start on, given or read", () => {
    for (const step of OnboardingStep.options) {
      for (const answered of [true, false]) {
        const line = onboardingLine({ kind: "step", step, answered })
        plain(line)
        expect(line).toMatch(WORKING)
        expect(words(line)).toBeLessThanOrEqual(6)
      }
    }
  })
})

describe("the first line of each kind of turn", () => {
  const ellie = { orgId: "org-1", assistant: "Ellie" }
  const first = (on: Parameters<typeof waitingLine>[0]) =>
    waitingLine(on, 0, ellie)

  it("names what the turn is on, never the same words every turn", () => {
    // A card just answered.
    expect(first({ kind: "step", step: "contact", answered: true })).toEqual({
      kind: "planning",
      label: "Noting your phone and email",
    })
    expect(
      first({ kind: "step", step: "business.phone", answered: true }).label
    ).toBe("Saving your phone number")
    expect(first({ kind: "step", step: "upload", answered: true }).label).toBe(
      "Looking at your photos"
    )
    // A typed message: what it does, true at any step.
    expect(first({ kind: "reading", about: "answer" })).toEqual({
      kind: "reading",
      label: "Looking at your answer",
    })
    expect(first({ kind: "reading", about: "change" }).label).toBe(
      "Looking at what you'd like to change"
    )
    expect(first({ kind: "reading", about: "question" }).label).toBe(
      "Looking into your question"
    )
    // The plan's own line, once it writes one.
    expect(first({ kind: "doing", text: "Reading about your rates" })).toEqual({
      kind: "planning",
      label: "Reading about your rates",
    })
    // A turn with no status: the assistant's own moment.
    expect(first(null)).toEqual({
      kind: "reading",
      label: "Ellie is reading your message",
    })
  })

  it("moves on from a status that stood quiet, and never says thinking", () => {
    const on = { kind: "step", step: "contact", answered: true } as const
    expect(waitingLine(on, 11.9, ellie).label).toBe(
      "Noting your phone and email"
    )
    expect(waitingLine(on, 12, ellie)).toEqual({
      kind: "still",
      label: "Ellie is still working on it",
    })
    expect(waitingLine(on, 30, ellie).label).toBe(
      "Ellie is taking longer than usual"
    )
    for (const seconds of [0, 4, 12, 30, 600]) {
      expect(waitingLine(null, seconds, ellie).label).not.toMatch(/think/i)
    }
  })
})

describe("the assistant's moments", () => {
  const ellie = { orgId: "org-1", assistant: "Ellie" }

  it("moves on at 4 s, 12 s and 30 s and never rotates", () => {
    expect(turnMoment(0, ellie)).toBe("Ellie is reading your message")
    expect(turnMoment(3.9, ellie)).toBe("Ellie is reading your message")
    expect(turnMoment(4, ellie)).toBe("Ellie is putting a reply together")
    expect(turnMoment(11.9, ellie)).toBe("Ellie is putting a reply together")
    expect(turnMoment(12, ellie)).toBe("Ellie is still working on it")
    expect(turnMoment(29.9, ellie)).toBe("Ellie is still working on it")
    expect(turnMoment(30, ellie)).toBe("Ellie is taking longer than usual")
    expect(turnMoment(600, ellie)).toBe("Ellie is taking longer than usual")
    expect(writingBack(ellie)).toBe("Ellie is writing back")
    expect(planningLine(ellie)).toBe("Ellie is planning your website")
  })

  it("is written bare before the assistant has a name", () => {
    for (const assistant of [undefined, null, "", "  "]) {
      const ctx = { orgId: "org-1", assistant }
      expect(turnMoment(0, ctx)).toBe("Reading your message")
      expect(turnMoment(5, ctx)).toBe("Putting a reply together")
      expect(turnMoment(20, ctx)).toBe("Still working on it")
      expect(turnMoment(40, ctx)).toBe("Taking longer than usual")
      expect(writingBack(ctx)).toBe("Writing back")
      expect(planningLine(ctx)).toBe("Planning your website")
    }
  })

  it("uses Reme when the owner chose it as the assistant's name", () => {
    const ctx = { orgId: "org-1", assistant: "Reme" }
    expect(turnMoment(0, ctx)).toBe("Reme is reading your message")
  })
})

const segment = (
  kind: ActivitySegment["kind"],
  state: ActivitySegment["state"],
  over: Partial<ActivitySegment> = {}
): ActivitySegment => ({
  id: `${kind}-1`,
  kind,
  state,
  steps: [],
  at: "2026-10-22T10:00:00.000Z",
  names: {
    business: "Spark Cleaning",
    host: "spark.mnobinur.dev",
    domain: "spark.mnobinur.dev",
  },
  ...over,
})

const JOBS = [
  "onboarding",
  "website",
  "golive",
  "change",
  "address",
  "domain",
  "purchase",
  "google",
] as const
const STATES = ["upcoming", "now", "waiting", "done", "failed"] as const
const ORGS = Array.from({ length: 30 }, (_, i) => `org-${i}`)

describe("segment copy", () => {
  it("says what an owner task waits for by the step that waits, its note first", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const address = (id: string, note?: string, total?: number) =>
      segment("address", "waiting", {
        steps: [
          { id: "find_out", state: "done" },
          {
            id,
            state: "waiting",
            ...(note && { note }),
            ...(total && { count: { done: 0, total } }),
          },
        ],
        names: { domain: "spark.co.uk", provider: "123-reg" },
      })
    expect(pillLine(address("records"), ctx)).toBe(
      "Ellie is waiting for your DNS change"
    )
    // As many changes as the card listed, and no number when none is known.
    expect(segmentLine(address("records", undefined, 3), ctx)).toBe(
      "3 changes to make at 123-reg"
    )
    expect(segmentLine(address("records", undefined, 1), ctx)).toBe(
      "One change to make at 123-reg"
    )
    expect(segmentLine(address("records"), ctx)).toBe(
      "Changes to make at 123-reg"
    )
    expect(pillLine(address("purchase"), ctx)).toBe(
      "Ellie is waiting for your payment"
    )
    // Buying it elsewhere waits on the owner's own purchase.
    expect(pillLine(address("purchase", "buying spark.co.uk"), ctx)).toBe(
      "Ellie is waiting for you to buy it"
    )
    expect(segmentLine(address("purchase", "Buying spark.co.uk"), ctx)).toBe(
      "Buying spark.co.uk"
    )
    const google = segment("google", "waiting", {
      steps: [
        { id: "sign_in", state: "done" },
        { id: "permissions", state: "waiting" },
      ],
    })
    expect(waitingRow(google)).toBe("Waiting for you to allow access")
    expect(segmentLine(google, ctx)).toBe("Google needs one more permission")
    // No time the panel cannot see: the sign-in link's life is not stored.
    const signIn = segment("google", "waiting", {
      steps: [{ id: "sign_in", state: "waiting" }],
    })
    expect(segmentLine(signIn, ctx)).toBe("Google needs you to sign in again")
  })

  it("writes clean titles, lines and pills for every job, state, org and name", () => {
    for (const kind of JOBS) {
      for (const state of STATES) {
        for (const assistant of ["Ellie", null, "Maya"]) {
          for (const orgId of ORGS) {
            const ctx = { orgId, assistant }
            const s = segment(kind, state)
            const title = segmentTitle(s, ctx)
            plain(title)
            expect(title).toMatch(STARTS)
            for (const line of [
              segmentLine(s, ctx, {
                elapsedSeconds: 130,
                until: "11:50",
                provider: "Cloudflare",
              }),
              pillLine(s, ctx),
              waitingRow(s, "11:50"),
            ]) {
              if (line === null) continue
              expect(line).not.toMatch(DASH)
              expect(line).not.toMatch(INTERNAL)
              expect(line).not.toMatch(/Reme/)
              expect(line).not.toMatch(/…/)
            }
          }
        }
      }
    }
  })

  it("uses the persona's name where the title is the assistant's own moment", () => {
    for (const orgId of ORGS) {
      const ctx = { orgId, assistant: "Ellie" }
      expect(segmentTitle(segment("website", "now"), ctx)).toMatch(/^Ellie is /)
      expect(segmentTitle(segment("change", "now"), ctx)).toMatch(/^Ellie is /)
      expect(pillLine(segment("website", "now"), ctx)).toBe(
        "Ellie is building your website"
      )
      expect(pillLine(segment("purchase", "waiting"), ctx)).toBe(
        "Ellie is waiting for your payment"
      )
      expect(pillLine(segment("domain", "now"), ctx)).toBe(
        "Ellie is connecting spark.mnobinur.dev"
      )
      const bare = { orgId, assistant: null }
      expect(segmentTitle(segment("website", "now"), bare)).toMatch(
        /^(?:Building|Putting) your website/
      )
      expect(pillLine(segment("purchase", "waiting"), bare)).toBe(
        "Waiting for your payment"
      )
    }
  })

  it("names what the website build is doing now in its title", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const on = (id: string, count?: { done: number; total: number }) =>
      segmentTitle(
        segment("website", "now", {
          steps: [
            { id: "planning", state: "done" },
            { id, state: "now", ...(count && { count }) },
          ],
        }),
        ctx
      )
    expect(on("writing", { done: 2, total: 7 })).toMatch(
      /^Ellie is writing your (?:pages|website)$/
    )
    expect(on("writing", { done: 7, total: 7 })).toMatch(
      /^Ellie is putting your (?:pages|website) together$/
    )
    expect(on("checking")).toMatch(
      /^Ellie is checking (?:your site|every page)$/
    )
    expect(on("photos")).toMatch(/^Ellie is making (?:your )?photos/)
    // The same org reads the same words on every poll.
    expect(on("checking")).toBe(on("checking"))
    // Ready, or no step at work, keeps the build's own title.
    expect(on("ready")).toMatch(/^Ellie is (?:building|putting) your website/)
  })

  it("says what comes next for a job not begun, never that it is under way", () => {
    for (const orgId of ORGS) {
      const ctx = { orgId, assistant: "Ellie" }
      expect(segmentTitle(segment("website", "upcoming"), ctx)).toMatch(
        /^(?:Your website comes next|Next, your website)$/
      )
      expect(segmentTitle(segment("golive", "upcoming"), ctx)).toMatch(
        /^Then (?:it|your website) goes live$/
      )
    }
  })

  it("puts the business, host and domain in the titles", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    expect(segmentTitle(segment("onboarding", "now"), ctx)).toContain(
      "Spark Cleaning"
    )
    expect(segmentTitle(segment("onboarding", "done"), ctx)).toContain(
      "Spark Cleaning"
    )
    // The published site's host is the panel's noise, not its meaning.
    expect(segmentTitle(segment("golive", "done"), ctx)).not.toContain(
      "spark.mnobinur.dev"
    )
    expect(segmentTitle(segment("domain", "now"), ctx)).toContain(
      "spark.mnobinur.dev"
    )
    expect(segmentTitle(segment("purchase", "done"), ctx)).toMatch(
      /spark\.mnobinur\.dev/i
    )
    const nameless = segment("onboarding", "now", { names: undefined })
    expect(segmentTitle(nameless, ctx)).toBe("Getting started")
    expect(segmentLine(nameless, ctx)).toBeNull()
  })

  it("never changes a title between polls, and varies it between orgs", () => {
    const s = segment("website", "now")
    const seen = new Set<string>()
    for (const orgId of ORGS) {
      const ctx = { orgId, assistant: "Ellie" }
      const first = segmentTitle(s, ctx)
      expect(segmentTitle(s, ctx)).toBe(first)
      seen.add(first as string)
    }
    expect(seen.size).toBeGreaterThan(1)
    expect(seen.size).toBeLessThanOrEqual(3)
  })

  it("counts nothing in onboarding: the question says enough", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const steps = (open: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `step_${i}`,
        state: i < 8 - open ? ("done" as const) : ("next" as const),
      }))
    expect(
      segmentLine(segment("onboarding", "now", { steps: steps(5) }), ctx)
    ).toBeNull()
  })

  it("names a change by what it changes, or by the website", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const titled = segment("change", "now", {
      names: { change: "your hero title" },
    })
    expect(segmentTitle(titled, ctx)).toBe("Ellie is updating your hero title")
    expect(pillLine(titled, ctx)).toBe("Ellie is updating your hero title")
    expect(segmentTitle(segment("change", "now"), ctx)).toBe(
      "Ellie is updating your website"
    )
    expect(pillLine(segment("change", "now"), { orgId: "org-1" })).toBe(
      "Updating your website"
    )
  })

  it("writes the lines under a running or waiting job", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    expect(
      segmentLine(
        segment("website", "now", { usual_seconds: 360, late_seconds: 600 }),
        ctx,
        { elapsedSeconds: 130 }
      )
    ).toBe("2 minutes so far, about 6 to 10 minutes")
    // The quick lane, rounded outward to whole minutes; an api that sends no
    // late time gets the high end half again.
    const quick = { usual_seconds: 45, late_seconds: 90 }
    expect(segmentLine(segment("change", "now", quick), ctx)).toBe(
      "About 1 to 2 minutes"
    )
    expect(
      segmentLine(segment("change", "now", quick), ctx, { elapsedSeconds: 30 })
    ).toBe("Under a minute so far, about 1 to 2 minutes")
    expect(
      segmentLine(segment("website", "now", { usual_seconds: 360 }), ctx)
    ).toBe("About 6 to 9 minutes")
    // A change names the step it is on, with the range beside it.
    const doing = "Checking the page"
    expect(segmentLine(segment("change", "now", quick), ctx, { doing })).toBe(
      "Checking the page, about 1 to 2 minutes"
    )
    expect(
      segmentLine(segment("change", "now", quick), ctx, {
        doing,
        elapsedSeconds: 130,
      })
    ).toBe("Checking the page, taking a little longer, about 3 to 5 minutes")
    expect(segmentLine(segment("change", "now"), ctx, { doing })).toBe(
      "Checking the page"
    )
    expect(segmentLine(segment("website", "now"), ctx)).toBeNull()
    expect(
      segmentLine(
        segment("change", "now", { step: "Adding the new photos" }),
        ctx,
        {
          elapsedSeconds: 30,
        }
      )
    ).toBe("Adding the new photos")
    expect(
      segmentLine(segment("change", "now"), ctx, { elapsedSeconds: 30 })
    ).toBe("Under a minute so far")
    // Past the top the range moves up to start above the time gone, and a
    // restart is said whatever the time.
    const timed = { usual_seconds: 360, late_seconds: 600 }
    expect(
      segmentLine(segment("website", "now", timed), ctx, {
        elapsedSeconds: 545,
      })
    ).toBe("9 minutes so far, about 6 to 10 minutes")
    expect(
      segmentLine(segment("website", "now", timed), ctx, {
        elapsedSeconds: 650,
      })
    ).toBe("Taking a little longer, about 11 to 15 minutes")
    expect(
      segmentLine(segment("change", "now", quick), ctx, {
        elapsedSeconds: 130,
      })
    ).toBe("Taking a little longer, about 3 to 5 minutes")
    expect(
      segmentLine(
        segment("website", "now", { ...timed, restarted: true }),
        ctx,
        { elapsedSeconds: 700 }
      )
    ).toBe("11 minutes so far, Ellie restarted it")
    expect(
      segmentLine(segment("change", "now", { restarted: true }), {
        orgId: "org-1",
      })
    ).toBe("Your assistant restarted it")
    expect(
      segmentLine(segment("domain", "waiting"), ctx, { provider: "Cloudflare" })
    ).toBe("Changes to make at Cloudflare")
    expect(
      segmentLine(segment("purchase", "waiting"), ctx, { until: "11:50" })
    ).toBe("Pay by 11:50 to keep the name")
    expect(waitingRow(segment("purchase", "waiting"), "11:50")).toBe(
      "Waiting for your payment, until 11:50"
    )
    expect(segmentLine(segment("website", "done"), ctx)).toBeNull()
  })

  it("never quotes a range that has passed or says a phrase twice", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const s = segment("website", "now", {
      usual_seconds: 360,
      late_seconds: 600,
    })
    for (let elapsedSeconds = 0; elapsedSeconds <= 3000; elapsedSeconds += 7) {
      const line = segmentLine(s, ctx, { elapsedSeconds }) as string
      const [, low, high] = /about (\d+) to (\d+) minutes/.exec(line) ?? []
      expect(Number(high)).toBeGreaterThan(Number(low))
      // The top has not passed, or the range starts above the time gone.
      expect(
        Number(high) * 60 >= elapsedSeconds || Number(low) * 60 > elapsedSeconds
      ).toBe(true)
      expect(line.match(/minutes?/g)?.length).toBeLessThanOrEqual(2)
      expect(line).not.toMatch(/usually/i)
    }
  })

  it("says what stopped and what happens next", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const failed = segment("domain", "failed")
    expect(segmentTitle(failed, ctx)).toBe("The domain connection stopped")
    expect(
      segmentLine(failed, ctx, { why: "Cloudflare did not answer." })
    ).toBe("Cloudflare did not answer. Ask Ellie to try again")
    expect(segmentLine(failed, { orgId: "org-1" })).toBe(
      "Ask your assistant to try again"
    )
  })

  it("has no title for a kind that is one row", () => {
    for (const kind of [
      "reminder",
      "review",
      "question",
      "checkin",
      "turn",
    ] as const) {
      expect(segmentTitle(segment(kind, "now"), { orgId: "org-1" })).toBeNull()
    }
    expect(waitingRow(segment("review", "waiting"), "11:50")).toBe(
      "Waiting for your approval to publish, until 11:50"
    )
  })
})

describe("page lines", () => {
  const STANDING = [
    "golive",
    "address",
    "domain",
    "purchase",
    "google",
  ] as const

  it("writes a clean line for every standing kind, state and name", () => {
    for (const kind of STANDING) {
      for (const state of STATES) {
        for (const assistant of ["Ellie", null, "Maya"]) {
          const line = standingLine(
            segment(kind, state),
            { orgId: "org-1", assistant },
            {
              when: "today, 3:40 pm",
              renews: "1 October 2027",
              synced: "today, 9:30 am",
              until: "11:50",
            }
          )
          plain(line)
          expect(line).toMatch(STARTS)
        }
      }
    }
  })

  it("says where each thing stands", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const at = (
      kind: ActivitySegment["kind"],
      state: ActivitySegment["state"]
    ) => segment(kind, state)
    expect(
      standingLine(at("golive", "done"), ctx, { when: "today, 3:40 pm" })
    ).toBe("Published today, 3:40 pm")
    expect(standingLine(at("golive", "done"), ctx)).toBe("Published")
    expect(standingLine(at("domain", "done"), ctx)).toBe("Live")
    expect(standingLine(at("address", "done"), ctx)).toBe("Live")
    expect(
      standingLine(at("address", "done"), ctx, { renews: "1 October 2027" })
    ).toBe("Live. Renews 1 October 2027")
    expect(
      standingLine(
        segment("google", "done", {
          numbers: { clicks: 12, impressions: 340 },
        }),
        ctx,
        { synced: "today, 9:30 am" }
      )
    ).toBe(
      "12 clicks and 340 appearances on Google in the last 28 days. Data read today, 9:30 am"
    )
    expect(standingLine(at("domain", "waiting"), ctx)).toBe(
      "Waiting for your DNS change"
    )
    expect(
      standingLine(at("purchase", "done"), ctx, { renews: "1 October 2027" })
    ).toBe("Renews 1 October 2027")
    expect(standingLine(at("google", "done"), ctx)).toBe(
      "Verified, pages sent. No data yet"
    )
    expect(standingLine(at("domain", "failed"), ctx)).toBe(
      "The domain connection stopped. Ask Ellie to try again"
    )
    expect(
      standingLine(at("domain", "failed"), { orgId: "o", assistant: null })
    ).toBe("The domain connection stopped. Ask your assistant to try again")
  })

  it("words what a task's furthest done step proved, and nothing for a step that proves nothing", () => {
    const ctx = { orgId: "org-1", assistant: null }
    const done = (...ids: string[]) =>
      segment("address", "now", {
        steps: ids.map((id) => ({ id, state: "done" as const, at: STAMP })),
        names: { domain: "spark.co.uk" },
      })
    expect(proofOf(done("find_out", "choose"), ctx)).toBeNull()
    expect(proofOf(done("find_out", "records"), ctx)).toEqual({
      text: "Your DNS points spark.co.uk at your website",
      at: STAMP,
    })
    // The furthest, not the first, and never a go-live segment's own "loads".
    expect(proofOf(done("records", "certificate"), ctx)?.text).toBe(
      "The certificate for spark.co.uk is active"
    )
    expect(
      proofOf(segment("golive", "done", { steps: done("loads").steps }), ctx)
    ).toBeNull()
    for (const id of ["purchase", "ownership", "sign_in", "first_data"]) {
      const text = proofOf(done(id), ctx)?.text ?? ""
      plain(text)
      expect(text).toMatch(STARTS)
    }
  })

  it("tells a task nothing has begun from one that has", () => {
    const steps = (...states: ("next" | "done")[]) =>
      states.map((state, i) => ({ id: `s${i}`, state }))
    expect(
      notStarted(segment("address", "upcoming", { steps: steps("next") }))
    ).toBe(true)
    expect(
      notStarted(
        segment("google", "upcoming", { steps: steps("done", "next") })
      )
    ).toBe(false)
    expect(notStarted(segment("reminder", "upcoming"))).toBe(false)
  })

  it("follows the domain's steps while it connects", () => {
    const ctx = { orgId: "org-1", assistant: null }
    const steps = (here: number) =>
      ["dns", "certificate", "loads"].map((id, i) => ({
        id,
        state:
          i < here
            ? ("done" as const)
            : i === here
              ? ("now" as const)
              : ("next" as const),
      }))
    expect(
      standingLine(segment("domain", "now", { steps: steps(1) }), ctx)
    ).toBe("The certificate is on its way")
    expect(
      standingLine(segment("domain", "now", { steps: steps(2) }), ctx)
    ).toBe("Checking your website loads on it")
  })

  it("reads the build's step at work, never a count of the whole", () => {
    const stage = (id: string, count?: { done: number; total: number }) =>
      segment("website", "now", {
        steps: [
          { id: "planning", state: "done" },
          { id, state: "now", ...(count && { count }) },
        ],
      })
    expect(workLine(stage("writing", { done: 3, total: 6 }))).toBe(
      "3 pages are done, 3 to go"
    )
    expect(workLine(segment("website", "now"))).toBeNull()
    expect(
      workLine(segment("change", "now", { step: "Changing the opening hours" }))
    ).toBe("Changing the opening hours")
  })

  it("writes every action as a button and a plain first-person message", () => {
    const keys: PageActionKey[] = ["own", "dns", "pay", "google", "failed"]
    for (const key of keys) {
      for (const subject of ["sparkcleaning.co.uk", "Google", null]) {
        const { label, ask } = pageAction(key, subject)
        for (const text of [label, ask]) {
          expect(text).not.toMatch(DASH)
          expect(text).not.toMatch(/Reme/)
          expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
        }
      }
    }
    expect(pageAction("dns", "sparkcleaning.co.uk").ask).toBe(
      "What do I change at my DNS provider for sparkcleaning.co.uk?"
    )
  })
})

describe("cleanArg", () => {
  it("collapses whitespace and cuts at 32 characters with an ellipsis", () => {
    expect(cleanArg("  two   spaces\n here ")).toBe("two spaces here")
    const cut = cleanArg("x".repeat(10).concat(" ", "y".repeat(40)))
    expect(cut).toHaveLength(32)
    expect(cut?.endsWith("…")).toBe(true)
    expect(cleanArg("   ")).toBeNull()
    expect(cleanArg(undefined)).toBeNull()
  })

  it("turns a URL into a domain and a slug into a page name", () => {
    expect(cleanArg("https://Spark.example.com/a/b?c=1#d", "domain")).toBe(
      "spark.example.com"
    )
    expect(cleanArg("spark.example.com", "domain")).toBe("spark.example.com")
    expect(cleanArg("end-of-tenancy", "page")).toBe("End of tenancy")
    expect(cleanArg("Services", "page")).toBe("Services")
  })

  it("refuses an id, a hash, an enum value or a staff code", () => {
    expect(cleanArg("0f8f8431-3a1b-4c2d-9e7f-1234567890ab")).toBeNull()
    expect(cleanArg("ead99cb0f3")).toBeNull()
    expect(cleanArg("awaiting_payment")).toBeNull()
    expect(cleanArg("OPS-123")).toBeNull()
    expect(cleanArg("Spark Cleaning")).toBe("Spark Cleaning")
  })

  it("swaps a dash for a comma", () => {
    expect(cleanArg("one — two")).toBe("one, two")
  })
})

describe("elapsedText", () => {
  it("speaks in minutes", () => {
    expect(elapsedText(5)).toBe("Under a minute")
    expect(elapsedText(60)).toBe("1 minute")
    expect(elapsedText(130)).toBe("2 minutes")
  })
})
