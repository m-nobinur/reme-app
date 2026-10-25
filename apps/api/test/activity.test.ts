import {
  Activity,
  type ActivitySegment,
  type AssignmentState,
  type BuildSummary,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  type ActivityInput,
  type ActivityRows,
  activityOf,
  CHANGE_STEPS,
  type DomainRow,
  GOLIVE_STEPS,
  PURCHASE_HOLD_MS,
  withOnboarding,
} from "../src/activity.ts"
import { activityFor, EXPECTED_SECONDS, STAGES } from "../src/workspace.ts"

const NOW = new Date("2026-10-22T12:00:00.000Z")
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString()
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const build = (
  state: AssignmentState,
  over: Partial<BuildSummary> = {}
): BuildSummary => ({
  assignment_id: ID(1),
  kind: "site.build",
  state,
  goal: "First website",
  lane: "full",
  activity: activityFor("full", state),
  revision: null,
  created_at: ago(5),
  updated_at: ago(1),
  ...over,
})

const approval = (assignment: string, expires = ago(-60 * 24)) =>
  ({
    kind: "approval",
    version: 1,
    request: {
      approval_id: ID(50),
      assignment_id: assignment,
      requested_at: ago(2),
      expires_at: expires,
    },
  }) as ActivityInput["approvals"][number]

const rows = (over: Partial<ActivityRows> = {}): ActivityRows => ({
  since: ago(60 * 24 * 3),
  domains: [],
  google: null,
  heartbeat: null,
  first_live: null,
  live_at: null,
  ...over,
})

const LIVE = {
  host: "spark.example.com",
  url: "https://spark.example.com",
  live: { revision_id: ID(9), version: 1, assignment_id: ID(1) },
}
const NOT_LIVE = { host: null, url: null, live: null }

const input = (over: Partial<ActivityInput> = {}): ActivityInput => ({
  site: NOT_LIVE,
  business: "Spark Cleaning",
  builds: [],
  approvals: [],
  questions: [],
  feed: [],
  due: [],
  notes: [],
  rows: rows(),
  ...over,
})

/** The view, checked against the contract the web reads. */
const view = (over: Partial<ActivityInput> = {}) =>
  Activity.parse(activityOf(input(over), NOW))

const states = (s: ActivitySegment | undefined) =>
  s?.steps.map((step) => `${step.id}:${step.state}`)

const domain = (over: Partial<DomainRow>): DomainRow => ({
  id: ID(20),
  name: "sparkcleaning.co.uk",
  origin: "connected",
  state: "awaiting_dns",
  check: null,
  registration: null,
  checkout: false,
  created_at: ago(10),
  activated_at: null,
  ...over,
})

describe("journey", () => {
  it("lists the website and going live, upcoming, before any build", () => {
    const { journey } = view()
    expect(journey.map((s) => [s.kind, s.state])).toEqual([
      ["website", "upcoming"],
      ["golive", "upcoming"],
    ])
    expect(journey[0]?.steps.map((s) => s.id)).toEqual([...STAGES])
    expect(journey[0]?.names).toEqual({ business: "Spark Cleaning" })
  })

  it("follows the build's six stages by their ids", () => {
    const { journey, now } = view({ builds: [build("implementing")] })
    expect(journey[0]?.state).toBe("now")
    expect(states(journey[0])).toEqual([
      "planning:done",
      "photos:skipped",
      "writing:now",
      "polishing:next",
      "checking:next",
      "ready:next",
    ])
    // The first build is the journey's, never a change in Now.
    expect(now).toEqual([])
  })

  it("says a rebuild is fixing what stopped the last build", () => {
    const [website] = view({
      builds: [build("implementing", { retry: true })],
    }).journey
    expect(website).toMatchObject({
      state: "now",
      step: "Fixing what stopped the last build",
    })
    expect(view({ builds: [build("implementing")] }).journey[0]?.step).toBe(
      undefined
    )
  })

  it("leaves the website to come once the owner stopped its build", () => {
    const { journey, now } = view({ builds: [build("cancelled")] })
    expect(journey[0]?.state).toBe("upcoming")
    expect(states(journey[0])?.every((s) => s.endsWith(":next"))).toBe(true)
    expect(now).toEqual([])
  })

  it("shows a change to the draft as a change after the built website, by its label", () => {
    const { journey, now } = view({
      builds: [
        build("implementing", {
          kind: "site.revise",
          lane: "quick",
          label: "your hero subtitle",
        }),
        build("cancelled", { assignment_id: ID(2) }),
      ],
    })
    expect(journey.map((s) => [s.kind, s.state])).toEqual([
      ["website", "done"],
      ["change", "now"],
      ["golive", "upcoming"],
    ])
    expect(journey[1]?.names).toEqual({ change: "your hero subtitle" })
    expect(now).toEqual([])
    // Stopped, the draft it would replace stands again.
    const back = view({
      builds: [
        build("cancelled", { kind: "site.revise" }),
        build("awaiting_review", { assignment_id: ID(2) }),
      ],
    }).journey
    expect(back.map((s) => [s.kind, s.state])).toEqual([
      ["website", "done"],
      ["golive", "upcoming"],
    ])
  })

  it("puts the first review in going live, with its expiry, not in Waiting on you", () => {
    const expires = ago(-60 * 24)
    const { journey, waiting } = view({
      builds: [build("awaiting_review")],
      approvals: [approval(ID(1), expires)],
    })
    expect(journey[0]?.state).toBe("done")
    expect(journey[1]).toMatchObject({ state: "waiting", deadline: expires })
    expect(states(journey[1])).toEqual([
      "approval:waiting",
      "publishing:next",
      "loads:next",
    ])
    expect(waiting).toEqual([])
  })

  it("is gone once the site is live, and going live is done today", () => {
    const { journey, done } = view({
      site: LIVE,
      rows: rows({ first_live: { at: ago(30), assignment_id: ID(1) } }),
      feed: [
        {
          kind: "report",
          event_id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
          assignment_id: ID(1),
          at: ago(30),
          what: "published",
          revision: { revision_id: ID(9), version: 1 },
        },
      ],
    })
    expect(journey).toEqual([])
    expect(done.map((s) => s.kind)).toEqual(["golive"])
    expect(done[0]?.names).toEqual({
      business: "Spark Cleaning",
      host: "spark.example.com",
    })
  })
})

describe("change", () => {
  it("runs a quick edit through the four steps by state", () => {
    const { now } = view({
      site: LIVE,
      builds: [build("implementing", { lane: "quick", activity: [] })],
    })
    expect(states(now[0])).toEqual([
      "understanding:done",
      "making:now",
      "checking:next",
      "ready:next",
    ])
  })

  it("waits on the owner when the build is blocked on a question", () => {
    const { waiting } = view({
      site: LIVE,
      builds: [build("blocked_on_information", { activity: [] })],
    })
    expect(waiting[0]?.kind).toBe("change")
    expect(waiting[0]?.steps.some((s) => s.state === "waiting")).toBe(true)
  })

  it("is done once ready, and its review waits on the owner", () => {
    const { done, waiting } = view({
      site: LIVE,
      builds: [build("awaiting_review", { ready_at: ago(2) })],
      approvals: [approval(ID(1))],
    })
    expect(done[0]).toMatchObject({ kind: "change", state: "done" })
    expect(done[0]?.steps.every((s) => s.state === "done")).toBe(true)
    expect(waiting.map((s) => s.kind)).toEqual(["review"])
  })

  it("carries its lane's usual time while at work, the one the chat quotes, and none once it waits or is done", () => {
    const expected = EXPECTED_SECONDS
    const at = (
      b: BuildSummary,
      site: typeof LIVE | typeof NOT_LIVE = LIVE
    ) => {
      const a = view({ site, builds: [b], expected })
      return [...a.journey, ...a.now, ...a.waiting, ...a.done].find(
        (seg) => seg.kind === "change" || seg.kind === "website"
      )?.usual_seconds
    }
    expect(at(build("implementing", { lane: "quick", activity: [] }))).toBe(
      expected.quick.p50
    )
    expect(at(build("validating"))).toBe(expected.full.p50)
    expect(at(build("implementing"), NOT_LIVE)).toBe(expected.full.p50)
    expect(at(build("blocked_on_information", { activity: [] }))).toBe(
      undefined
    )
    expect(at(build("awaiting_review", { ready_at: ago(2) }))).toBe(undefined)
    // The late time beside it, and a restart said while it runs.
    const working = view({
      site: LIVE,
      builds: [build("implementing", { restarted: true })],
      expected,
    }).now[0]
    expect(working).toMatchObject({
      late_seconds: expected.full.p95,
      restarted: true,
    })
  })

  it("names a change by its label, and a build without one by nothing", () => {
    const named = (label?: string) =>
      view({
        site: LIVE,
        builds: [
          build("implementing", {
            lane: "quick",
            activity: [],
            ...(label && { label }),
          }),
        ],
      }).now[0]
    expect(named("your hero title")?.names).toEqual({
      change: "your hero title",
    })
    expect(named()?.names).toBeUndefined()
  })

  it("keeps the same step ids in every state", () => {
    for (const state of [
      "queued",
      "planning",
      "validating",
      "awaiting_review",
    ] as const) {
      const { now, done } = view({ site: LIVE, builds: [build(state)] })
      const seg = [...now, ...done][0]
      expect(seg?.steps.map((s) => s.id)).toEqual([...CHANGE_STEPS])
    }
  })
})

describe("domain", () => {
  it("waits on the owner's DNS change, then the certificate, then the load", () => {
    const at = (row: Partial<DomainRow>) => {
      const a = view({ rows: rows({ domains: [domain(row)] }) })
      return [...a.now, ...a.waiting, ...a.done][0]
    }
    expect(states(at({}))).toEqual([
      "dns:waiting",
      "certificate:next",
      "loads:next",
    ])
    expect(at({})?.state).toBe("waiting")
    expect(
      states(at({ state: "verifying", check: "pending_certificate" }))
    ).toEqual(["dns:done", "certificate:now", "loads:next"])
    expect(states(at({ state: "verifying", check: "valid" }))).toEqual([
      "dns:done",
      "certificate:done",
      "loads:now",
    ])
    const live = at({ state: "active", activated_at: ago(5) })
    expect(live).toMatchObject({
      state: "done",
      names: { domain: "sparkcleaning.co.uk" },
    })
  })
})

describe("purchase", () => {
  const bought = (over: Partial<DomainRow>) =>
    domain({ origin: "purchased", state: "awaiting_payment", ...over })

  it("waits on the details, then the payment, until the name's hold runs out", () => {
    const details = view({ rows: rows({ domains: [bought({})] }) }).waiting[0]
    expect(states(details)).toEqual([
      "details:waiting",
      "payment:next",
      "registration:next",
      "connecting:next",
    ])
    expect(details?.deadline).toBe(
      new Date(Date.parse(ago(10)) + PURCHASE_HOLD_MS).toISOString()
    )
    const pay = view({ rows: rows({ domains: [bought({ checkout: true })] }) })
      .waiting[0]
    expect(pay?.steps[1]).toEqual({ id: "payment", state: "waiting" })
  })

  it("lists an expired Checkout as stopped in Done today", () => {
    const { done, waiting } = view({
      rows: rows({
        domains: [
          bought({ state: "abandoned", checkout: true, created_at: ago(180) }),
        ],
      }),
    })
    expect(waiting).toEqual([])
    expect(done[0]).toMatchObject({ kind: "purchase", state: "failed" })
    expect(done[0]?.steps[1]?.state).toBe("now")
  })

  it("registers, then connects", () => {
    const paying = view({
      rows: rows({ domains: [bought({ state: "verifying", checkout: true })] }),
    }).now[0]
    expect(paying?.steps[2]?.state).toBe("now")
    const connecting = view({
      rows: rows({
        domains: [
          bought({
            state: "verifying",
            checkout: true,
            registration: { status: "registered" },
          }),
        ],
      }),
    }).now[0]
    expect(connecting?.steps[3]?.state).toBe("now")
  })

  it("lists a bought domain's renewal in Coming up", () => {
    const { upcoming } = view({
      rows: rows({
        domains: [
          bought({
            state: "active",
            activated_at: ago(60 * 24 * 30),
            registration: { expires_at: "2027-10-01T00:00:00Z" },
          }),
        ],
      }),
    })
    expect(upcoming).toEqual([
      expect.objectContaining({
        kind: "purchase",
        state: "upcoming",
        at: "2027-10-01T00:00:00.000Z",
      }),
    ])
  })
})

describe("google", () => {
  const google = (over: Partial<NonNullable<ActivityRows["google"]>>) =>
    view({
      rows: rows({
        google: {
          state: "active",
          connected_at: ago(20),
          property: null,
          ...over,
        },
      }),
    })

  it("waits on a sign in again when the connection needs it", () => {
    expect(states(google({ state: "needs_reauth" }).waiting[0])).toEqual([
      "sign_in:waiting",
      "verify:next",
      "sitemap:next",
    ])
  })

  it("verifies, sends the sitemap, then is done", () => {
    const property = {
      state: "pending" as const,
      verified_at: null,
      sitemap_at: null,
      synced_at: null,
      created_at: ago(20),
    }
    expect(google({ property }).now[0]?.steps[1]?.state).toBe("now")
    const verified = {
      ...property,
      state: "verified" as const,
      verified_at: ago(15),
    }
    expect(google({ property: verified }).now[0]?.steps[2]?.state).toBe("now")
    const sent = google({ property: { ...verified, sitemap_at: ago(10) } })
    expect(sent.done[0]).toMatchObject({ kind: "google", at: ago(10) })
  })

  it("has no segment before a connection or after it ended", () => {
    expect(google({ state: "revoked" }).now).toEqual([])
    expect(view().now).toEqual([])
  })
})

describe("standing", () => {
  const month = 60 * 24 * 30

  it("keeps the latest publish, a domain and Google however old", () => {
    const { standing } = view({
      site: LIVE,
      rows: rows({
        live_at: ago(month),
        domains: [
          domain({ state: "active", activated_at: ago(month * 2) }),
          domain({ id: ID(21), name: "old.co.uk", state: "abandoned" }),
        ],
        google: {
          state: "active",
          connected_at: ago(month),
          property: {
            state: "verified",
            verified_at: ago(month),
            sitemap_at: ago(month),
            synced_at: ago(60),
            created_at: ago(month),
          },
        },
      }),
    })
    expect(standing?.map((s) => `${s.kind}:${s.state}`)).toEqual([
      "golive:done",
      "domain:done",
      "google:done",
    ])
    expect(standing?.[0]).toMatchObject({ at: ago(month) })
    expect(standing?.[2]).toMatchObject({ synced_at: ago(60) })
  })

  it("has nothing for a site that is not live and has no Google", () => {
    expect(view({ rows: rows({ live_at: ago(5) }) }).standing).toEqual([])
  })
})

describe("reminders and check-ins", () => {
  it("lists the next three reminders at any distance and the next check-in", () => {
    const note = (n: number, due: string | null) =>
      ({
        id: ID(n),
        title: "Call",
        due_at: due,
      }) as ActivityInput["notes"][number]
    const { upcoming } = view({
      notes: [
        note(1, ago(30)),
        note(2, ago(-60)),
        note(3, ago(-60 * 24 * 40)),
        note(4, ago(-60 * 24 * 41)),
        note(5, ago(-60 * 24 * 42)),
        note(6, null),
      ],
      rows: rows({ heartbeat: { next: ago(-120), last: null } }),
    })
    expect(upcoming.map((s) => s.id)).toEqual([
      `reminder:${ID(2)}`,
      "checkin:next",
      `reminder:${ID(3)}`,
      `reminder:${ID(4)}`,
    ])
  })

  it("lists a quiet check-in as done with nothing sent", () => {
    const { done } = view({
      rows: rows({
        heartbeat: { next: null, last: { at: ago(60), outcome: "skipped" } },
      }),
    })
    expect(done).toEqual([
      expect.objectContaining({
        kind: "checkin",
        state: "done",
        steps: [{ id: "message", state: "skipped" }],
      }),
    ])
  })

  it("leaves out a check-in that failed", () => {
    const { done } = view({
      rows: rows({
        heartbeat: { next: null, last: { at: ago(60), outcome: "failed" } },
      }),
    })
    expect(done).toEqual([])
  })

  it("lists a reminder that came due today as done", () => {
    const { done } = view({
      due: [
        {
          kind: "reminder",
          reminder_id: ID(7),
          title: "Call",
          due_at: ago(90),
        },
        {
          kind: "reminder",
          reminder_id: ID(8),
          title: "Old",
          due_at: ago(60 * 30),
        },
      ],
    })
    expect(done.map((s) => s.id)).toEqual([`reminder:${ID(7)}`])
  })
})

describe("questions", () => {
  it("waits on the owner with the question's expiry", () => {
    const expires = ago(-60)
    const { waiting } = view({
      questions: [
        {
          kind: "question",
          request: {
            request_id: ID(30),
            requested_at: ago(5),
            expires_at: expires,
          },
        } as ActivityInput["questions"][number],
      ],
    })
    expect(waiting[0]).toMatchObject({ kind: "question", deadline: expires })
  })
})

it("keeps the website's six stage ids from the first event to ready", () => {
  for (const state of [
    "queued",
    "planning",
    "implementing",
    "validating",
    "awaiting_review",
  ] as const) {
    const { journey } = view({ builds: [build(state)] })
    expect(journey[0]?.steps.map((s) => s.id)).toEqual([...STAGES])
    expect(journey[1]?.steps.map((s) => s.id)).toEqual([...GOLIVE_STEPS])
  }
})

describe("withOnboarding", () => {
  const onboarding: ActivitySegment = {
    id: "onboarding",
    kind: "onboarding",
    state: "now",
    steps: [{ id: "work", state: "now" }],
    at: ago(10),
  }

  it("puts onboarding first in the journey", () => {
    const activity = withOnboarding(view(), onboarding)
    expect(activity.journey.map((s) => s.kind)).toEqual([
      "onboarding",
      "website",
      "golive",
    ])
  })

  it("adds nothing once the site is live", () => {
    expect(withOnboarding(view({ site: LIVE }), onboarding).journey).toEqual([])
  })
})
