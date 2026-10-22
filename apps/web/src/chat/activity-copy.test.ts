import {
  type ActivitySegment,
  CosToolName,
  PLAN_FACT_KEYS,
  PlanNext,
} from "@workspace/contracts"
import {
  type BuildStage,
  changeAsked,
  cleanArg,
  elapsedText,
  type LineState,
  onboardingLine,
  type PageActionKey,
  pageAction,
  pillLine,
  planningLine,
  segmentLine,
  segmentTitle,
  stageLine,
  standingLine,
  toolLine,
  turnMoment,
  waitingRow,
  workLine,
  writingBack,
} from "@workspace/ui/lib/activity-copy"
import { describe, expect, it } from "vitest"

const words = (line: string) => line.split(/\s+/).length
const DASH = /[–—]/
// A UUID, a run of 7 or more hex characters, a snake_case value or a staff code.
const INTERNAL =
  /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{7,}|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b[A-Z]{3}-\d{3}\b/i
const WORKING = /^[A-Z][a-z]+ing\b/
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
        expect(working).toMatch(WORKING)
        expect(words(working)).toBeGreaterThanOrEqual(2)
        expect(words(working)).toBeLessThanOrEqual(6)
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
      "Writing the pages, 3 of 6"
    )
    expect(stageLine("writing", "done", { total: 6 })).toBe("Wrote 6 pages")
    expect(stageLine("checking", "working", args)).toBe(
      "Fixing 2 things the checks found"
    )
    expect(stageLine("checking", "working", { fixes: 1 })).toBe(
      "Fixing 1 thing the checks found"
    )
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
      const line = onboardingLine({ kind: "next", next })
      plain(line)
      expect(line).toMatch(WORKING)
      expect(words(line)).toBeLessThanOrEqual(6)
    }
    expect(onboardingLine({ kind: "fact", key: "business.offerings" })).toBe(
      "Noting your services"
    )
    expect(onboardingLine({ kind: "next", next: "review_quote_form" })).toBe(
      "Drafting your quote form"
    )
  })
})

describe("the assistant's moments", () => {
  const ellie = { orgId: "org-1", assistant: "Ellie" }

  it("moves on at 4 s and 12 s and never rotates", () => {
    expect(turnMoment(0, ellie)).toBe("Ellie is reading your message")
    expect(turnMoment(3.9, ellie)).toBe("Ellie is reading your message")
    expect(turnMoment(4, ellie)).toBe("Ellie is thinking it through")
    expect(turnMoment(11.9, ellie)).toBe("Ellie is thinking it through")
    expect(turnMoment(12, ellie)).toBe("Ellie is still on it")
    expect(turnMoment(600, ellie)).toBe("Ellie is still on it")
    expect(turnMoment(0, ellie, "answer")).toBe("Ellie is reading your answer")
    expect(writingBack(ellie)).toBe("Ellie is writing back")
    expect(planningLine(ellie)).toBe("Ellie is planning your website")
  })

  it("is written bare before the assistant has a name, and never says Reme", () => {
    for (const assistant of [undefined, null, "", "  ", "Reme", "reme"]) {
      const ctx = { orgId: "org-1", assistant }
      expect(turnMoment(0, ctx)).toBe("Reading your message")
      expect(turnMoment(5, ctx)).toBe("Thinking it through")
      expect(turnMoment(20, ctx)).toBe("Still on it")
      expect(writingBack(ctx)).toBe("Writing back")
      expect(planningLine(ctx)).toBe("Planning your website")
    }
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
  "domain",
  "purchase",
  "google",
] as const
const STATES = ["upcoming", "now", "waiting", "done", "failed"] as const
const ORGS = Array.from({ length: 30 }, (_, i) => `org-${i}`)

describe("segment copy", () => {
  it("writes clean titles, lines and pills for every job, state, org and name", () => {
    for (const kind of JOBS) {
      for (const state of STATES) {
        for (const assistant of ["Ellie", null, "Reme"]) {
          for (const orgId of ORGS) {
            const ctx = { orgId, assistant }
            const s = segment(kind, state)
            const title = segmentTitle(s, ctx)
            plain(title)
            expect(title).toMatch(/^[A-Z]/)
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

  it("puts the business, host and domain in the titles", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    expect(segmentTitle(segment("onboarding", "now"), ctx)).toContain(
      "Spark Cleaning"
    )
    expect(segmentTitle(segment("onboarding", "done"), ctx)).toContain(
      "Spark Cleaning"
    )
    expect(segmentTitle(segment("golive", "done"), ctx)).toContain(
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
    expect(segmentLine(nameless, ctx)).toBe(
      "A few questions, then your website"
    )
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

  it("counts what is left in onboarding", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const steps = (open: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `step_${i}`,
        state: i < 8 - open ? ("done" as const) : ("next" as const),
      }))
    expect(
      segmentLine(segment("onboarding", "now", { steps: steps(5) }), ctx)
    ).toBe("5 more to go, then Ellie starts on your website")
    expect(
      segmentLine(segment("onboarding", "now", { steps: steps(1) }), ctx)
    ).toBe("One more, then Ellie starts on your website")
    expect(
      segmentLine(segment("onboarding", "now", { steps: steps(1) }), {
        orgId: "org-1",
      })
    ).toBe("One more, then work on your website starts")
  })

  it("writes the lines under a running or waiting job", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    expect(
      segmentLine(segment("website", "now"), ctx, { elapsedSeconds: 130 })
    ).toBe("2 minutes so far, usually 4 to 6 minutes")
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
    expect(
      segmentLine(segment("domain", "waiting"), ctx, { provider: "Cloudflare" })
    ).toBe("One change to make at Cloudflare")
    expect(
      segmentLine(segment("purchase", "waiting"), ctx, { until: "11:50" })
    ).toBe("Pay by 11:50 to keep the name")
    expect(waitingRow(segment("purchase", "waiting"), "11:50")).toBe(
      "Waiting for your payment, until 11:50"
    )
    expect(segmentLine(segment("website", "done"), ctx)).toBeNull()
  })

  it("says what stopped and what happens next", () => {
    const ctx = { orgId: "org-1", assistant: "Ellie" }
    const failed = segment("domain", "failed")
    expect(segmentTitle(failed, ctx)).toBe("The domain connection stopped")
    expect(
      segmentLine(failed, ctx, { why: "Cloudflare did not answer." })
    ).toBe("Cloudflare did not answer. Ellie is looking into it")
    expect(segmentLine(failed, { orgId: "org-1" })).toBe("Looking into it")
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
      "Waiting for your approval, until 11:50"
    )
  })
})

describe("page lines", () => {
  const STANDING = ["golive", "domain", "purchase", "google"] as const

  it("writes a clean line for every standing kind, state and name", () => {
    for (const kind of STANDING) {
      for (const state of STATES) {
        for (const assistant of ["Ellie", null, "Reme"]) {
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
          expect(line).toMatch(/^[A-Z]/)
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
      "The domain connection stopped. Ellie is looking into it"
    )
    expect(
      standingLine(at("domain", "failed"), { orgId: "o", assistant: null })
    ).toBe("The domain connection stopped. Looking into it")
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
      "Writing the pages, 3 of 6"
    )
    expect(workLine(segment("website", "now"))).toBeNull()
    expect(
      workLine(segment("change", "now", { step: "Changing the opening hours" }))
    ).toBe("Changing the opening hours")
  })

  it("writes every action as a button and a plain first-person message", () => {
    const keys: PageActionKey[] = [
      "own",
      "dns",
      "pay",
      "google",
      "signin",
      "failed",
    ]
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
