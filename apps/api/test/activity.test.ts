import {
  Activity,
  type ActivitySegment,
  type AssignmentState,
  type BuildSummary,
  type OwnerTask,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  type ActivityInput,
  type ActivityRows,
  activityOf,
  CHANGE_STEPS,
  type DomainRow,
  GOLIVE_STEPS,
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
  search: { properties: 1, synced_at: null, clicks: 0, impressions: 0 },
  heartbeat: null,
  first_live: null,
  live_at: null,
  tasks: [],
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

const bought = (over: Partial<DomainRow> = {}): DomainRow => ({
  id: ID(20),
  name: "sparkcleaning.co.uk",
  registration: { expires_at: "2027-10-01T00:00:00Z" },
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
    // The site's host is no copy input: the panel says "published", not where.
    expect(done[0]?.names).toEqual({ business: "Spark Cleaning" })
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

  it("keeps a quick edit checking its page until its review opens", () => {
    const { now } = view({
      site: LIVE,
      builds: [build("preview_ready", { lane: "quick", activity: [] })],
    })
    expect(now[0]).toMatchObject({ state: "now", step: "Checking the page" })
    expect(states(now[0])).toEqual([
      "understanding:done",
      "making:done",
      "checking:now",
      "ready:next",
    ])
    // A full build is done once its preview exists.
    expect(view({ site: LIVE, builds: [build("preview_ready")] }).now).toEqual(
      []
    )
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

describe("renewal", () => {
  it("lists a bought domain's renewal in Coming up", () => {
    const { upcoming } = view({ rows: rows({ domains: [bought()] }) })
    expect(upcoming).toEqual([
      expect.objectContaining({
        kind: "purchase",
        state: "upcoming",
        at: "2027-10-01T00:00:00.000Z",
      }),
    ])
  })
})

describe("owner tasks", () => {
  const step = (
    name: string,
    state: string,
    over: Record<string, unknown> = {}
  ) => ({
    step: name,
    state,
    note: null,
    blocked_on: null,
    deadline: null,
    changed_at: null,
    ...over,
  })
  const task = (steps: ReturnType<typeof step>[], over = {}) =>
    ({
      id: ID(30),
      kind: "address",
      state: "active",
      later_until: null,
      detail: { name: "sparkcleaning.co.uk", provider: "123-reg" },
      created_at: ago(30),
      done_at: null,
      steps,
      ...over,
    }) as OwnerTask
  const groups = (...tasks: OwnerTask[]) => view({ rows: rows({ tasks }) })

  it("waits on the owner with the step's note and deadline, named by domain and provider", () => {
    const { waiting, now } = groups(
      task([
        step("find_out", "done"),
        step("records", "blocked", {
          blocked_on: "owner_action",
          note: "Two records to add",
          deadline: ago(-60),
        }),
        step("loads", "pending"),
      ])
    )
    expect(now).toEqual([])
    expect(waiting).toEqual([
      {
        id: `address:${ID(30)}`,
        kind: "address",
        state: "waiting",
        steps: [
          { id: "find_out", state: "done" },
          { id: "records", state: "waiting", note: "Two records to add" },
          { id: "loads", state: "next" },
        ],
        at: ago(30),
        deadline: ago(-60),
        names: { domain: "sparkcleaning.co.uk", provider: "123-reg" },
      },
    ])
  })

  it("puts a step at work in Now, one not begun in Coming up, a finished one in Done", () => {
    expect(
      groups(task([step("records", "done"), step("loads", "in_progress")]))
        .now[0]?.kind
    ).toBe("address")
    const google = task(
      [step("sign_in", "done"), step("first_data", "pending")],
      {
        kind: "google",
        detail: {},
      }
    )
    expect(groups(google).upcoming).toEqual([
      expect.objectContaining({ id: "google", state: "upcoming" }),
    ])
    const done = groups(
      task([step("loads", "done")], { state: "done", done_at: ago(5) })
    ).done
    expect(done[0]).toMatchObject({ state: "done", at: ago(5) })
  })

  it("is done once every step is, before the task row catches up, dated by the last step", () => {
    const { done, now, upcoming } = groups(
      task([
        step("find_out", "done", { changed_at: ago(40) }),
        step("purchase", "skipped"),
        step("records", "done", { changed_at: ago(20) }),
        step("loads", "done", { changed_at: ago(10) }),
      ])
    )
    expect([...now, ...upcoming]).toEqual([])
    expect(done[0]).toMatchObject({
      id: `address:${ID(30)}`,
      state: "done",
      at: ago(10),
    })
  })

  it("counts the records step by the changes the connect card listed", () => {
    const [waiting] = groups(
      task([step("records", "blocked", { blocked_on: "owner_action" })], {
        detail: { name: "sparkcleaning.co.uk", changes: 3 },
      })
    ).waiting
    expect(waiting?.steps[0]).toEqual({
      id: "records",
      state: "waiting",
      count: { done: 0, total: 3 },
    })
  })

  it("has no segment for a task put off or declined", () => {
    const off = groups(
      task([step("purchase", "pending")], { state: "later" }),
      task([step("records", "blocked")], { state: "declined" })
    )
    expect([...off.now, ...off.waiting, ...off.upcoming, ...off.done]).toEqual(
      []
    )
  })
})

describe("standing", () => {
  const month = 60 * 24 * 30
  const step = (name: string, state: string, over = {}) => ({
    step: name,
    state,
    note: null,
    blocked_on: null,
    deadline: null,
    changed_at: null,
    ...over,
  })
  const task = (kind: string, steps: ReturnType<typeof step>[], over = {}) =>
    ({
      id: ID(30),
      kind,
      state: "active",
      later_until: null,
      detail: kind === "address" ? { name: "sparkcleaning.co.uk" } : {},
      created_at: ago(month),
      done_at: null,
      steps,
      ...over,
    }) as OwnerTask

  it("keeps the latest publish, the address and Google tasks, and a renewal however old", () => {
    const { standing } = view({
      site: LIVE,
      rows: rows({
        live_at: ago(month),
        domains: [bought()],
        search: {
          properties: 1,
          synced_at: ago(60),
          clicks: 12,
          impressions: 340,
        },
        tasks: [
          task("google", [step("first_data", "done")], {
            id: ID(31),
            state: "done",
            done_at: ago(60),
          }),
          task("address", [step("loads", "done")], {
            state: "done",
            done_at: ago(month),
          }),
        ],
      }),
    })
    expect(standing?.map((s) => `${s.kind}:${s.state}`)).toEqual([
      "golive:done",
      "google:done",
      "address:done",
      "purchase:upcoming",
    ])
    expect(standing?.[1]).toMatchObject({
      synced_at: ago(60),
      numbers: { clicks: 12, impressions: 340 },
    })
  })

  it("says no numbers until Google has sent a day with searches", () => {
    const { standing } = view({
      rows: rows({
        search: {
          properties: 1,
          synced_at: ago(60),
          clicks: 0,
          impressions: 0,
        },
        tasks: [task("google", [step("sitemap", "done")])],
      }),
    })
    expect(standing?.[0]?.numbers).toBeUndefined()
    expect(standing?.[0]?.synced_at).toBe(ago(60))
  })

  it("lists no Google numbers coming while Reme holds no property, but a Google wait still shows", () => {
    const google = (steps: ReturnType<typeof step>[]) =>
      view({
        rows: rows({
          search: { properties: 0, synced_at: null, clicks: 0, impressions: 0 },
          tasks: [task("google", steps)],
        }),
      }).standing?.map((s) => `${s.kind}:${s.state}`)
    expect(
      google([step("verify", "done"), step("first_data", "pending")])
    ).toEqual([])
    expect(google([step("sign_in", "blocked")])).toEqual(["google:waiting"])
  })

  it("dates each done step of a task by when it moved", () => {
    const { standing } = view({
      rows: rows({
        tasks: [
          task("address", [
            step("records", "done", { changed_at: ago(20) }),
            step("certificate", "in_progress", { changed_at: ago(5) }),
          ]),
        ],
      }),
    })
    expect(standing?.[0]?.steps).toEqual([
      { id: "records", state: "done", at: ago(20) },
      { id: "certificate", state: "now" },
    ])
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
