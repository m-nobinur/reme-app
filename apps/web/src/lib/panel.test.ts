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
import { completedOf, type PanelInput, pageOf, panelFor } from "./panel"

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

  it("moves finished onboarding to Completed and opens the website", () => {
    const panel = firstRun(
      [
        onboarding(8, "done"),
        {
          ...segment(
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
          usual_seconds: 360,
          late_seconds: 600,
        },
        segment("golive", "upcoming", along(GOLIVE_STEPS, -1), BUSINESS),
      ],
      {
        builds: [
          {
            ...build("implementing", "build-first"),
            // The build's own row names the pages written and at work.
            activity: [
              {
                id: "writing",
                label: "Writing the pages",
                done: 3,
                total: 6,
                now: true,
                items: [
                  { label: "Home", done: true },
                  { label: "Services", done: true },
                  { label: "About", done: true },
                  { label: "Contact", done: false, working: true },
                  { label: "Gallery", done: false, working: true },
                  { label: "Reviews", done: false },
                ],
              },
            ],
          },
        ],
      }
    )
    const [website, ...rest] = panel?.journey ?? []
    // Going live is not shown before the website is done.
    expect(rest).toEqual([])
    expect(panel?.done).toEqual([
      expect.objectContaining({
        text: "Fixture Clean set up",
        brief: "Services, service area, customers and 5 more",
      }),
    ])

    expect(website?.state).toBe("now")
    // The title says what is happening now.
    expect([
      "Ellie is writing your pages",
      "Ellie is writing your website",
    ]).toContain(website?.title)
    expect(website?.line).toBe("4 minutes so far, about 6 to 10 minutes")
    expect(website?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Planning", "done"],
      ["Photos", "skipped"],
      ["3 pages are done, 3 to go", "now"],
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
    const [golive, ...rest] = panel?.journey ?? []
    expect(rest).toEqual([])
    expect(panel?.done.map((item) => item.text)).toEqual([
      "Website built",
      "Fixture Clean set up",
    ])
    expect(golive?.title).toBe("Your website is ready")
    expect(golive?.line).toBeNull()
    expect(golive?.steps.map((each) => [each.label, each.state])).toEqual([
      ["Waiting for your approval to publish", "waiting"],
      ["Publishing", "next"],
      ["Checking it loads", "next"],
    ])
    expect(panel?.review).toBe(review)
    expect(panel?.waiting).toEqual([])
    expect(panel?.line.lead).toBe(
      "Ellie is waiting for your approval to publish"
    )

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
    const website = panel?.journey[0]
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
    const [planning, photos, writing] = panel?.journey[0]?.steps ?? []
    expect(writing?.label).toBe("2 pages are done, 4 to go")
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
    expect(domain?.line).toBe("Changes to make at your DNS provider")
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

  it("offers no next step once the site is live: the Website page links it", () => {
    expect(jobs?.suggestions).toEqual([])
  })
})

describe("tasks not started", () => {
  const unbegun = (kind: "address" | "google") =>
    segment(
      kind,
      "upcoming",
      (kind === "address"
        ? ["find_out", "choose", "records"]
        : ["sign_in", "verify"]
      ).map((id) => step(id, "next")),
      { id: kind === "google" ? "google" : "address:1" }
    )
  const withUpcoming = (...upcoming: ActivitySegment[]) =>
    panelFor(
      input({
        workspace: live({
          assistantName: "Ellie",
          activity: activity({ upcoming }),
        }),
      })
    )

  it("offers the next one as Up next with one button, the address before Google", () => {
    const panel = withUpcoming(unbegun("google"), unbegun("address"))
    expect(panel?.upNext).toEqual({
      id: "address:1",
      text: expect.stringMatching(/address/i),
      label: "Use your own domain",
      ask: "I'd like to use my own domain",
    })
    expect(panel?.upcoming).toEqual([])
    expect(withUpcoming(unbegun("google"))?.upNext).toMatchObject({
      label: "Connect Google",
    })
  })

  it("keeps a task that has begun in Coming up", () => {
    const panel = withUpcoming(
      segment("google", "upcoming", [
        step("sign_in", "done"),
        step("first_data", "next"),
      ])
    )
    expect(panel?.upNext).toBeNull()
    expect(panel?.upcoming.map((row) => row.text)).toEqual([
      "Your first search numbers from Google",
    ])
  })
})

describe("completedOf", () => {
  it("gives a task still open a row for its furthest done step, dated by that step", () => {
    const records = "2026-10-01T08:30:00.000Z"
    const open = segment(
      "address",
      "now",
      [
        step("find_out", "done", { at: "2026-10-01T08:00:00.000Z" }),
        step("records", "done", { at: records }),
        step("certificate", "now"),
      ],
      { id: "address:1", names: { domain: "spark.example.invalid" } }
    )
    const rows = completedOf(
      live({ activity: activity({ standing: [open] }) }),
      {
        orgId: ORG,
        assistant: "Ellie",
      }
    )
    expect(rows).toEqual([
      {
        id: "address:1:proof",
        text: "Your DNS points spark.example.invalid at your website",
        at: records,
        brief: null,
      },
    ])
    // Done, the task is one row, and its brief is what its last step proved.
    const done = completedOf(
      live({
        activity: activity({
          standing: [
            {
              ...open,
              state: "done",
              steps: [step("loads", "done", { at: records })],
            },
          ],
        }),
      }),
      { orgId: ORG, assistant: "Ellie" }
    )
    expect(done.map((row) => [row.text, row.brief])).toEqual([
      [
        "spark.example.invalid connected",
        "Your website loads at spark.example.invalid",
      ],
    ])
  })

  it("lists a first publish once, though the feed and the site's standing both hold it", () => {
    const published = (id: string) =>
      segment("golive", "done", along(GOLIVE_STEPS, GOLIVE_STEPS.length), {
        id,
        names: { host: HOST },
      })
    const rows = completedOf(
      live({
        activity: activity({
          done: [published("golive")],
          standing: [published("published")],
        }),
      }),
      { orgId: ORG, assistant: "Ellie" }
    )
    expect(rows.map((row) => row.text)).toEqual(["Website published"])
  })

  it("lists a domain once, though its address task and its standing row both hold it", () => {
    const names = { domain: "spark.example.invalid" }
    const rows = completedOf(
      live({
        activity: activity({
          done: [segment("address", "done", [], { id: "address:1", names })],
          standing: [segment("domain", "done", [], { id: "domain:1", names })],
        }),
      }),
      { orgId: ORG, assistant: "Ellie" }
    )
    expect(rows.map((row) => row.text)).toEqual([
      "spark.example.invalid connected",
    ])
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
    expect(done?.[1]).toBe("fixture.example.invalid connected")
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
    expect(panel?.line.lead).toBe("Your assistant")
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
  const line = (over: Partial<Workspace>) =>
    panelFor(input({ workspace: workspace(over) }))?.line

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

  it("says the assistant asks, never the staff member who did", () => {
    expect(
      line({
        live: 2,
        assistantName: "Ellie",
        attention: [question("Alex", "staff-1")],
      })
    ).toEqual({ tone: "live", lead: "Ellie", detail: "has a question for you" })
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
