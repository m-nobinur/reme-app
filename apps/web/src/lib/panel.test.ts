import type {
  Activity,
  ActivitySegment,
  ActivityStep,
  Conversation,
  Reminder,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import type { AttentionItem, Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { type PanelInput, pageOf, panelFor } from "./panel"

const ONBOARDING = "00000000-0000-4000-8000-00000000000a"
const CHAT = "00000000-0000-4000-8000-00000000000b"
const ORG = "00000000-0000-4000-8000-00000000000c"
const HOST = "fixture-clean.example.invalid"
const URL_ = `https://${HOST}`
/** 10:00 in London. */
const NOW = new Date("2026-10-01T09:00:00.000Z")
const ZONE = "Europe/London"
/** Four minutes before `NOW`. */
const STARTED = "2026-10-01T08:56:00.000Z"

const ROUTES = {
  home: "/app/_conversation/",
  chat: "/app/_conversation/c/$id",
  website: "/app/website",
  reminders: "/app/reminders",
  approvals: "/app/approvals",
  staff: "/app/staff",
}

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  ...EMPTY_WORKSPACE,
  ...over,
})

const build = (state: string, id = `build-${state}`) =>
  ({
    assignment_id: id,
    goal: "Add Saturday hours",
    state,
    revision: null,
    created_at: STARTED,
  }) as unknown as Workspace["builds"][number]

const approval = (
  assignmentId = "build-first",
  expiresAt: string | null = null
) =>
  ({
    kind: "approval",
    id: `approval-${assignmentId}`,
    version: 4,
    expiresAt,
    request: { assignment_id: assignmentId },
  }) as unknown as AttentionItem

const question = (raisedBy: string, raisedById: string | null = null) =>
  ({
    kind: "question",
    id: `question-${raisedBy}`,
    title: "Weekday hours",
    raisedBy,
    raisedById,
    expiresAt: null,
  }) as unknown as AttentionItem

const note = (id: string, title: string, due_at: string | null): Reminder => ({
  id,
  title,
  due_at,
  done_at: null,
  source: "owner",
  conversation_id: null,
  created_at: "2026-09-26T10:00:00.000Z",
  updated_at: "2026-09-26T10:00:00.000Z",
})

const onboardingChat = {
  id: ONBOARDING,
  kind: "onboarding",
  archived_at: null,
} as unknown as Conversation

const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  route: ROUTES.home,
  conversation: undefined,
  workspace: workspace(),
  orgId: ORG,
  business: "Fixture Clean",
  conversations: [],
  names: {},
  now: NOW,
  zone: ZONE,
  ...over,
})

const live = (over: Partial<Workspace> = {}) =>
  workspace({ live: 3, host: HOST, url: URL_, ...over })

/* Activity fixtures, as the api sends them -------------------------------- */

const step = (
  id: string,
  state: ActivityStep["state"],
  extra: Partial<ActivityStep> = {}
): ActivityStep => ({ id, state, ...extra })

/** Fixed steps, the one at `here` in `state`, those before it done. */
const along = (
  ids: readonly string[],
  here: number,
  state: "now" | "waiting" = "now"
) =>
  ids.map((id, i) => step(id, i < here ? "done" : i === here ? state : "next"))

const ONBOARDING_STEPS = [
  "work",
  "area",
  "customers",
  "contact",
  "assistant",
  "quote_form",
  "photos",
  "look",
]
const WEBSITE_STEPS = [
  "planning",
  "photos",
  "writing",
  "polishing",
  "checking",
  "ready",
]
const GOLIVE_STEPS = ["approval", "publishing", "loads"]

const segment = (
  kind: ActivitySegment["kind"],
  state: ActivitySegment["state"],
  steps: ActivityStep[] = [],
  extra: Partial<ActivitySegment> = {}
): ActivitySegment => ({
  id: kind,
  kind,
  state,
  steps,
  at: STARTED,
  ...extra,
})

const activity = (over: Partial<Activity> = {}): Activity => ({
  journey: [],
  now: [],
  waiting: [],
  upcoming: [],
  done: [],
  ...over,
})

const BUSINESS = { names: { business: "Fixture Clean" } }

/** Onboarding with the first `heard` steps settled, the next one open. */
const onboarding = (
  heard: number,
  state: "now" | "waiting" | "done" = "now"
): ActivitySegment => {
  const values = [
    "Regular cleans, end of tenancy",
    "South Manchester, 10 miles",
  ]
  return segment(
    "onboarding",
    state,
    ONBOARDING_STEPS.map((id, i) =>
      state === "done" || i < heard
        ? step(id, "done", values[i] ? { value: values[i] } : {})
        : i === heard
          ? step(id, state === "waiting" ? "waiting" : "now")
          : step(id, "next")
    ),
    BUSINESS
  )
}

const firstRun = (journey: ActivitySegment[], over: Partial<Workspace> = {}) =>
  panelFor(
    input({
      conversations: [onboardingChat],
      workspace: workspace({
        assistantName: "Ellie",
        activity: activity({ journey }),
        ...over,
      }),
    })
  )

describe("pageOf", () => {
  it("names each page, and tells the getting-started chat apart", () => {
    expect(pageOf(ROUTES.home, undefined, null)).toBe("home")
    expect(pageOf(ROUTES.chat, CHAT, ONBOARDING)).toBe("chat")
    expect(pageOf(ROUTES.chat, ONBOARDING, ONBOARDING)).toBe("onboarding")
    expect(pageOf(ROUTES.website, undefined, null)).toBe("website")
    expect(pageOf(ROUTES.reminders, undefined, null)).toBe("reminders")
    expect(pageOf(ROUTES.approvals, undefined, null)).toBe("approvals")
    expect(pageOf(ROUTES.staff, undefined, null)).toBe("elsewhere")
    expect(pageOf(undefined, undefined, null)).toBe("elsewhere")
  })
})

describe("when the panel hides", () => {
  it("hides on pages with nothing under way, waiting or due", () => {
    for (const route of [ROUTES.staff, ROUTES.approvals, ROUTES.reminders]) {
      expect(panelFor(input({ route, workspace: live() }))).toBeNull()
      expect(panelFor(input({ route }))).toBeNull()
    }
  })

  it("leaves a new owner's Website page to its own empty state", () => {
    expect(panelFor(input({ route: ROUTES.website }))).toBeNull()
    expect(
      panelFor(input({ route: ROUTES.website, business: null }))
    ).toBeNull()
  })

  it("shows elsewhere while a job runs, and on reminders while one is ahead", () => {
    expect(
      panelFor(
        input({
          route: ROUTES.staff,
          workspace: live({ builds: [build("implementing")] }),
        })
      )
    ).not.toBeNull()
    expect(
      panelFor(
        input({
          route: ROUTES.staff,
          workspace: live({
            activity: activity({
              now: [segment("google", "now", along(["sign_in"], 0))],
            }),
          }),
        })
      )
    ).not.toBeNull()
    expect(
      panelFor(
        input({
          route: ROUTES.reminders,
          workspace: live({
            reminderNotes: [note("a", "Order cloths", null)],
          }),
        })
      )
    ).not.toBeNull()
  })
})

describe("the first run", () => {
  it("ticks each onboarding step as it lands, with what was heard", () => {
    const early = firstRun([onboarding(1)])?.journey
    expect(early).toHaveLength(1)
    const [setup] = early ?? []
    expect([
      "Getting Fixture Clean ready",
      "Setting up Fixture Clean",
    ]).toContain(setup?.title)
    expect(setup?.line).toBeNull()
    expect(setup?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Services", "done"],
      ["Where do you work?", "now"],
      ["Customers", "next"],
      ["Contact details", "next"],
      ["Your assistant", "next"],
      ["Quote requirements", "next"],
      ["Photos", "next"],
      ["Look and feel", "next"],
    ])

    // The next fact lands: its step ticks, and the next one opens.
    const later = firstRun([onboarding(2)])?.journey[0]
    expect(later?.steps[1]).toMatchObject({
      label: "Service area",
      state: "done",
    })
    expect(later?.steps[2]?.state).toBe("now")
    expect(later?.line).toBeNull()
  })

  it("says the owner's turn, and the pill waits on them", () => {
    const panel = firstRun([onboarding(7, "waiting")])
    expect(panel?.journey[0]?.steps.at(-1)?.state).toBe("waiting")
    expect(panel?.journey[0]?.line).toBeNull()
    expect(panel?.line).toEqual({
      tone: "idle",
      lead: "Ellie is waiting for your answer",
    })
    expect(panel?.suggestions).toEqual([{ kind: "onboarding", id: ONBOARDING }])
  })

  it("folds onboarding to one ticked line and opens the website", () => {
    const panel = firstRun(
      [
        onboarding(8, "done"),
        segment(
          "website",
          "now",
          [
            step("planning", "done"),
            step("photos", "skipped"),
            step("writing", "now", { count: { done: 3, total: 6 } }),
            ...along(WEBSITE_STEPS, 0).slice(3),
          ],
          BUSINESS
        ),
        segment("golive", "upcoming", along(GOLIVE_STEPS, -1), BUSINESS),
      ],
      { builds: [build("implementing", "build-first")] }
    )
    const [setup, website, ...rest] = panel?.journey ?? []
    // Going live is not shown before the website is done.
    expect(rest).toEqual([])
    expect(setup?.state).toBe("done")
    expect([
      "Fixture Clean is set up",
      "Finished setting up Fixture Clean",
    ]).toContain(setup?.title)
    // The working title, kept while a segment that just finished folds.
    expect([
      "Getting Fixture Clean ready",
      "Setting up Fixture Clean",
    ]).toContain(setup?.working)
    expect(setup?.line).toBeNull()

    expect(website?.state).toBe("now")
    expect([
      "Ellie is building your website",
      "Ellie is putting your website together",
    ]).toContain(website?.title)
    expect(website?.line).toBe("4 minutes so far, usually 5 to 10 minutes")
    expect(website?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Planning", "done"],
      ["Photos", "skipped"],
      ["Writing the pages, 3 of 6", "now"],
      ["Polishing", "next"],
      ["Checking", "next"],
      ["Ready", "next"],
    ])
    expect(website?.steps[2]?.kind).toBe("writing")
    expect(website?.build?.assignment_id).toBe("build-first")
    expect(panel?.line).toEqual({
      tone: "working",
      lead: "Ellie is building your website",
    })
    // Now holds one segment, so Coming up is kept in view above the rest.
    expect(panel?.upcomingFirst).toBe(true)
  })

  it("puts the review in going live, not in Waiting on you", () => {
    const review = approval("build-first")
    const panel = firstRun(
      [
        onboarding(8, "done"),
        segment("website", "done", along(WEBSITE_STEPS, 6), BUSINESS),
        segment(
          "golive",
          "waiting",
          along(GOLIVE_STEPS, 0, "waiting"),
          BUSINESS
        ),
      ],
      {
        builds: [build("awaiting_review", "build-first")],
        attention: [review],
      }
    )
    const [, website, golive] = panel?.journey ?? []
    expect(website?.state).toBe("done")
    expect(golive?.title).toMatch(/^(Putting|Taking) your website live$/)
    expect(golive?.line).toBe("Ready when you are")
    expect(golive?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Waiting for you to publish", "waiting"],
      ["Publishing", "next"],
      ["Checking it loads", "next"],
    ])
    expect(panel?.review).toBe(review)
    expect(panel?.waiting).toEqual([])
    expect(panel?.line.lead).toBe("Ellie is waiting for you to publish")

    // On the approvals page the review is the page's, not the segment's.
    const approvals = panelFor(
      input({
        route: ROUTES.approvals,
        workspace: workspace({
          assistantName: "Ellie",
          builds: [build("awaiting_review", "build-first")],
          attention: [review],
          activity: activity({
            journey: [
              segment("golive", "waiting", along(GOLIVE_STEPS, 0, "waiting")),
            ],
          }),
        }),
      })
    )
    expect(approvals?.review).toBeNull()
  })

  it("keeps a failed segment open and says what happens next", () => {
    const panel = firstRun([
      onboarding(8, "done"),
      segment("website", "failed", along(WEBSITE_STEPS, 4), BUSINESS),
    ])
    const website = panel?.journey[1]
    expect(website?.title).toBe("The website build stopped")
    expect(website?.line).toBe("Ask Ellie to try again")
    expect(website?.steps[4]).toMatchObject({ label: "Checking", state: "now" })
    expect(panel?.line.lead).toBe("The website build stopped")
  })

  it("gives a counted step a spoken form without its count", () => {
    const steps = along(WEBSITE_STEPS, 2).map((each) =>
      each.id === "writing" ? { ...each, count: { done: 2, total: 6 } } : each
    )
    const panel = firstRun([
      onboarding(8, "done"),
      segment("website", "now", steps, BUSINESS),
    ])
    const [planning, photos, writing] = panel?.journey[1]?.steps ?? []
    expect(writing?.label).toBe("Writing the pages, 2 of 6")
    expect(writing?.said).toBe("Writing the pages")
    // A step with no count has nothing to leave out.
    expect(planning?.said).toBeUndefined()
    expect(photos?.said).toBeUndefined()
  })

  it("starts from a new chat or the getting-started chat before the journey", () => {
    expect(panelFor(input())?.suggestions).toEqual([{ kind: "start-website" }])
    expect(
      panelFor(input({ conversations: [onboardingChat] }))?.suggestions
    ).toEqual([{ kind: "onboarding", id: ONBOARDING }])
    // Nothing claims to be building before anything is.
    expect(
      panelFor(
        input({
          workspace: workspace({
            activity: activity({
              journey: [
                segment("website", "upcoming", along(WEBSITE_STEPS, -1)),
              ],
            }),
          }),
        })
      )?.journey
    ).toEqual([])
  })

  it("asks an account with no business to name one", () => {
    const panel = panelFor(input({ business: null }))
    expect(panel?.suggestions).toEqual([{ kind: "name-business" }])
    expect(panel?.line).toEqual({
      tone: "idle",
      lead: "Name your business",
      detail: "to get started",
    })
  })
})

describe("later jobs", () => {
  const jobs = panelFor(
    input({
      workspace: live({
        assistantName: "Ellie",
        activity: activity({
          now: [
            segment(
              "google",
              "now",
              along(["sign_in", "verify", "sitemap"], 1)
            ),
          ],
          waiting: [
            segment(
              "domain",
              "waiting",
              along(["dns", "certificate", "loads"], 0, "waiting"),
              {
                id: "domain:a",
                names: { domain: "fixture.example.invalid" },
              }
            ),
            segment(
              "purchase",
              "waiting",
              along(
                ["details", "payment", "registration", "connecting"],
                1,
                "waiting"
              ),
              {
                id: "purchase:b",
                names: { domain: "fixtureclean.example.invalid" },
                deadline: "2026-10-01T10:50:00.000Z",
              }
            ),
            segment("review", "waiting", [], { id: "review:c" }),
          ],
        }),
      }),
    })
  )

  it("runs Google in Now with its own steps", () => {
    const [google] = jobs?.now ?? []
    expect(google?.title).toMatch(
      /^(Connecting Google|Linking your site to Google)$/
    )
    expect(google?.line).toBe("Checking your site with Google")
    expect(google?.icon).toBe("google")
    expect(google?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Sign in", "done"],
      ["Verifying your site", "now"],
      ["Sending your pages to Google", "next"],
    ])
    expect(jobs?.line).toEqual({
      tone: "working",
      lead: "Ellie is connecting Google",
    })
  })

  it("gives every job at work or waiting a turn in the header", () => {
    const leads = jobs?.lines.map((each) => each.lead) ?? []
    expect(leads[0]).toBe("Ellie is connecting Google")
    expect(leads.length).toBeGreaterThan(1)
    expect(new Set(leads).size).toBe(leads.length)
    expect(jobs?.lines[0]).toEqual(jobs?.line)
  })

  it("waits on the owner for a DNS change and a payment, by when", () => {
    const [domain, purchase, ...rest] = jobs?.blocked ?? []
    // A review is answered in the panel's own list, not drawn twice.
    expect(rest).toEqual([])
    expect(domain?.title).toMatch(/fixture\.example\.invalid$/)
    expect(domain?.line).toBe("One change to make at your DNS provider")
    expect(domain?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Your DNS change", "waiting"],
      ["Certificate", "next"],
      ["Site loads on the new address", "next"],
    ])
    expect(purchase?.title).toMatch(/fixtureclean\.example\.invalid$/)
    expect(purchase?.line).toBe("Pay by 11:50 am to keep the name")
    expect(purchase?.steps.map((each) => each.label)).toEqual([
      "Your details",
      "Payment",
      "Registration",
      "Connecting",
    ])
    expect(purchase?.icon).toBe("payment")
  })

  it("opens the site once live, and offers nothing else", () => {
    expect(jobs?.suggestions).toEqual([
      { kind: "visit-site", host: HOST, url: URL_ },
    ])
    // One segment in Now: Coming up is kept above Waiting on you.
    expect(jobs?.upcomingFirst).toBe(true)
  })
})

describe("coming up and done today", () => {
  const reminders = [
    note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
    note("b", "Order cloths for next week", "2026-10-08T13:00:00.000Z"),
  ]
  const feed = activity({
    upcoming: [
      segment("reminder", "upcoming", [], {
        id: "reminder:a",
        at: "2026-10-01T13:00:00.000Z",
      }),
      segment("reminder", "upcoming", [], {
        id: "reminder:b",
        at: "2026-10-08T13:00:00.000Z",
      }),
      segment("checkin", "upcoming", [], {
        id: "checkin:next",
        at: "2026-10-02T09:00:00.000Z",
      }),
      segment("purchase", "upcoming", [], {
        id: "renewal:d",
        at: "2027-10-01T09:00:00.000Z",
        names: { domain: "fixture.example.invalid" },
      }),
    ],
    done: [
      segment("checkin", "done", [step("message", "skipped")], {
        id: "checkin:last",
      }),
      segment("domain", "done", along(["dns", "certificate", "loads"], 3), {
        id: "domain:a",
        names: { domain: "fixture.example.invalid" },
      }),
    ],
  })
  const at = (route: string, zone: string | null = ZONE) =>
    panelFor(
      input({
        route,
        zone,
        workspace: live({
          assistantName: "Ellie",
          reminderNotes: reminders,
          activity: feed,
        }),
      })
    )

  it("lists every reminder ahead, by its own title, with renewals and the next check-in", () => {
    expect(at(ROUTES.home)?.upcoming.map((item) => item.text)).toEqual([
      "Call the supplier",
      "Order cloths for next week",
      "Ellie's next check-in",
      "fixture.example.invalid is due for renewal",
    ])
    // The reminders page lists its own.
    expect(at(ROUTES.reminders)?.upcoming.map((item) => item.text)).toEqual([
      "Ellie's next check-in",
      "fixture.example.invalid is due for renewal",
    ])
  })

  it("keeps the next check-in out until onboarding is done", () => {
    const withJourney = (journey: ActivitySegment[]) =>
      panelFor(
        input({
          route: ROUTES.home,
          zone: ZONE,
          workspace: live({
            assistantName: "Ellie",
            activity: activity({
              journey,
              upcoming: feed.upcoming.slice(2, 3),
            }),
          }),
        })
      )?.upcoming
    expect(withJourney([onboarding(2)])).toEqual([])
    expect(withJourney([onboarding(8, "done")])?.map((i) => i.text)).toEqual([
      "Ellie's next check-in",
    ])
  })

  it("says what finished today, a quiet check-in too", () => {
    const done = at(ROUTES.home)?.done.map((item) => item.text)
    expect(done?.[0]).toBe("Ellie checked in, all clear")
    expect(done?.[1]).toMatch(/^Fixture\.example\.invalid is (live|working)$/)
  })

  it("says no time until the reader's zone is known", () => {
    expect(at(ROUTES.home, null)?.upcoming).toEqual([])
    expect(at(ROUTES.home, null)?.done).toEqual([])
  })
})

describe("on the Reminders page", () => {
  const line = (notes: Reminder[], zone: string | null = ZONE) =>
    panelFor(
      input({
        route: ROUTES.reminders,
        workspace: live({ reminderNotes: notes }),
        zone,
      })
    )?.line.lead

  it("says what is due today, or when the next one is", () => {
    expect(
      line([
        note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
        note("b", "Send the quote", "2026-10-01T15:30:00.000Z"),
      ])
    ).toBe("2 reminders today, the next at 2:00 pm")
    expect(
      line([note("a", "Call the supplier", "2026-10-03T08:30:00.000Z")])
    ).toBe("Nothing due today. The next reminder is Sat 3 Oct, 9:30 am")
    expect(line([note("a", "Order cloths", null)])).toBe(
      "One reminder, with no time set"
    )
  })

  it("counts, without a day, until the reader's zone is known", () => {
    expect(
      line(
        [
          note("a", "Call the supplier", "2026-10-01T13:00:00.000Z"),
          note("b", "Order cloths", null),
        ],
        null
      )
    ).toBe("2 reminders ahead")
  })
})

describe("on the Approvals page", () => {
  it("leaves reviews to the page, and still shows a question", () => {
    const panel = panelFor(
      input({
        route: ROUTES.approvals,
        workspace: live({ attention: [approval(), question("Alex")] }),
      })
    )
    expect(panel?.waiting.map((item) => item.kind)).toEqual(["question"])
    expect(panel?.line.lead).toBe("Alex")
    expect(
      panelFor(
        input({
          route: ROUTES.approvals,
          workspace: live({ attention: [approval()] }),
        })
      )
    ).toBeNull()
  })
})

describe("the one line", () => {
  const line = (over: Partial<Workspace>, names = {}) =>
    panelFor(input({ workspace: workspace(over), names }))?.line

  it("says what is most pressing", () => {
    expect(
      line({ live: 2, attention: [approval("a"), question("Sam")] })
    ).toEqual({
      tone: "live",
      lead: "Your changes",
      detail: "are ready to publish",
    })
    expect(
      line({ attention: [approval("a"), approval("b")], open: true })
    ).toEqual({
      tone: "idle",
      lead: "Your website",
      detail: "is ready to publish",
    })
    expect(
      line({ live: 2, attention: [question("A"), question("B")] })
    ).toEqual({ tone: "live", lead: "2 questions", detail: "for you" })
    expect(line({ live: 1 })).toEqual({
      tone: "live",
      lead: "Your website is live",
    })
    // One thing to say: the header holds still.
    expect(
      panelFor(input({ workspace: workspace({ live: 1 }) }))?.lines
    ).toHaveLength(1)
    expect(line({ open: true, builds: [build("paused")] })).toEqual({
      tone: "idle",
      lead: "Your website",
      detail: "is in progress",
    })
  })

  it("names who asked, from the directory", () => {
    expect(
      line(
        { live: 2, attention: [question("A colleague", "staff-1")] },
        {
          "staff-1": "Alex",
        }
      )
    ).toEqual({ tone: "live", lead: "Alex", detail: "has a question for you" })
  })
})

/** A UUID, a hex run of 7 or more with a number in it, a snake_case value or a staff code. */
const INTERNAL =
  /[0-9a-f]{8}-[0-9a-f]{4}-|\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b|\b[a-z]+_[a-z_]+\b|\b[A-Z]{3}-\d{3}\b/

describe("what the owner reads", () => {
  const KINDS: [ActivitySegment["kind"], string[]][] = [
    ["onboarding", ONBOARDING_STEPS],
    ["website", WEBSITE_STEPS],
    ["golive", GOLIVE_STEPS],
    ["change", ["understanding", "making", "checking", "ready"]],
    ["domain", ["dns", "certificate", "loads"]],
    ["purchase", ["details", "payment", "registration", "connecting"]],
    ["google", ["sign_in", "verify", "sitemap"]],
  ]
  const STATES: ActivitySegment["state"][] = [
    "now",
    "waiting",
    "done",
    "failed",
  ]

  /** Every sentence the panel writes, for every job in every state, with and without names. */
  const sentences = (assistantName: string | null) => {
    const found: string[] = []
    for (const [kind, ids] of KINDS) {
      for (const state of STATES) {
        const each = segment(kind, state, along(ids, 1), {
          id: `${kind}:${ORG}`,
          names: {
            business: "Fixture Clean",
            domain: "fixture.example.invalid",
          },
          deadline: "2026-10-01T10:50:00.000Z",
        })
        const panel = panelFor(
          input({
            conversations: [onboardingChat],
            workspace: workspace({
              assistantName,
              activity: activity({
                journey: [onboarding(8, "done"), each],
                now: [each],
                done: [each],
              }),
            }),
          })
        )
        for (const view of [...(panel?.journey ?? []), ...(panel?.now ?? [])]) {
          found.push(
            view.title,
            view.working,
            view.line ?? "",
            ...view.steps.map((s) => s.label)
          )
        }
        found.push(
          panel?.line.lead ?? "",
          panel?.line.detail ?? "",
          ...(panel?.done ?? []).map((item) => item.text)
        )
      }
    }
    return found.filter(Boolean)
  }

  it("holds no id, hash, raw value or staff code", () => {
    for (const text of [...sentences("Ellie"), ...sentences(null)]) {
      expect(text).not.toMatch(INTERNAL)
    }
    // The pattern does catch what it is for.
    for (const text of [
      "2f41c9ab-0000-4000-8000-000000000005",
      "Build ead99cb0",
      "release_candidate",
      "OPS-014",
    ]) {
      expect(text).toMatch(INTERNAL)
    }
  })

  it("names no version number, and never Reme for a named assistant", () => {
    const named = sentences("Ellie")
    for (const text of named) {
      expect(text).not.toMatch(/\bReme\b|\bversion \d|\bv\d\b/i)
    }
    expect(named.some((text) => text.includes("Ellie"))).toBe(true)
  })

  it("does not say Reme, or a name, for an assistant nobody has named", () => {
    for (const text of sentences(null)) {
      expect(text).not.toMatch(/\bReme\b/)
    }
  })

  it("says Reme when the owner chose it as the assistant's name", () => {
    expect(sentences("Reme").some((text) => /\bReme\b/.test(text))).toBe(true)
  })
})
