import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UPTIME_CRON } from "../src/uptime.ts"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * Open item 46 (ADR-032): every path through the assignment Workflow, driven
 * with a recording step and every collaborator stood in for, so the ordered
 * step names are a committed fact the staging deploy can compare. The
 * publisher's paths are recorded the same way in publish.test.ts, against a
 * database, and read the same file.
 */

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {
    env: unknown
    constructor(_ctx: unknown, env: unknown) {
      this.env = env
    }
  },
}))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))
vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))
// The publisher's step bodies are driven for real, against a database, in
// publish.test.ts; here only the assignment paths run.
vi.mock("../src/publish.ts", () => ({
  PROBE_MINUTES: [0, 2, 5, 10],
  accessible: async () => true,
  activate: async () => ({}),
  // The superseded preview's revision: the one the served site now names.
  latestRevision: async () => ({ id: "rev-live", status: "preview" }),
  probeHost: async () => ({ ok: true }),
  readTarget: async () => ({}),
  servedVerification: async () => "https://a-stg.remeai.co.uk/google1a.html",
  redriveQueued: async () => [],
  requestReview: async () => {
    if (script.reviewRefusal) {
      const { TransitionError } = await import("../src/state.ts")
      throw new TransitionError(script.reviewRefusal, "validation", "refused")
    }
    script.reviews++
    return { request: { approval_id: "a" }, replayed: false }
  },
  verifyArtifact: async () => ({ ok: true }),
  writePointer: async () => ({}),
}))
// Declared rather than written as a class expression in the object below,
// which biome cannot parse inside a mock factory.
const { AgentInstanceExistsError } = vi.hoisted(() => {
  class InstanceExists extends Error {}
  return { AgentInstanceExistsError: InstanceExists }
})
const dispatched: { message: unknown; photosSettled?: boolean }[] = []
// Whether the photo step had settled when the Developer was dispatched,
// whether it throws, and every event type the Workflow appended.
const photoStep = vi.hoisted(() => ({
  settled: false,
  fail: false,
  appended: [] as string[],
}))
// The real module underneath, so the gate reasons the Workflow matches on are
// the ones the gate actually emits. Only the agent entry point is stood in for.
vi.mock("@workspace/facade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/facade")>()),
  AgentInstanceExistsError,
  init: () => ({
    dispatch: async (request: { message: unknown }) => {
      dispatched.push({ ...request, photosSettled: photoStep.settled })
      return { submissionId: "s" }
    },
  }),
}))

const ROW = {
  kind: "site.build",
  id: "10000001-0000-4000-8000-000000000001",
  orgId: "10000001-0000-4000-8000-000000000000",
  goal: "probe",
  acceptanceCriteria: [],
  state: "implementing",
  version: 3,
}
const orgList: string[] = []
vi.mock("@workspace/db", () => ({
  appendEvent: async (_db: unknown, event: { type: string }) => {
    photoStep.appended.push(event.type)
    return "e"
  },
  assignments: {},
  facts: {},
  eq: () => ({}),
  listOrgIds: async () => [...orgList],
  // What each look finds: the question the build waits on and whether it is
  // answered. With nothing scripted, the round's question, answered.
  waitedOn: async () => {
    const seen = script.looks.shift() ?? { request_id: "q", fact_id: "f" }
    return [
      {
        assignment_id: ROW.id,
        request: { request_id: seen.request_id },
        answer: seen.fact_id ? { fact_id: seen.fact_id } : null,
        value: null,
        fact_id: seen.current ?? seen.fact_id,
      },
    ]
  },
  failureCode: () => "unknown",
  toFactRecord: (row: unknown) => ({
    ...(row as object),
    key: "business.phone",
  }),
  tenancy: () => ({
    close: async () => undefined,
    withOrg: async (_: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({ from: () => ({ where: async () => [ROW] }) }),
      }),
  }),
}))
vi.mock("../src/brief.ts", () => ({
  creationChoices: async () => ({
    withhold: [],
    model: "A",
    origin: script.origin,
    kind: "site.build",
    skip_review: script.skipReview,
    ...script.lane,
  }),
  takeSnapshot: async () => ({}),
  issueSpec: async () => ({}),
}))

const SUPERSEDED = "10000001-0000-4000-8000-00000000aaaa"
const script = {
  claims: [] as { claimed: boolean; superseded: string | null }[],
  provisions: [] as boolean[],
  verdicts: [] as string[],
  a11y: [] as string[],
  checkpoints: [] as boolean[],
  origin: "console" as "owner" | "console",
  reviews: 0,
  reviewRefusal: null as string | null,
  /** The revision a warm sandbox names, if any. */
  held: null as string | null,
  /** The lane the created event recorded; none is an instance from before lanes. */
  lane: {} as { lane?: string; change_kind?: string | null },
  /** Whether the one-call quick edit gets to a report. */
  quickDone: true as boolean,
  /** What each look at the plan's decision finds; none left is "build". */
  decisions: [] as ("build" | "change" | null)[],
  /** The owner chose "Skip all": the plan is built without the card's wait. */
  skipReview: false as boolean,
  planned: [] as number[],
  /** The axe run each `validateRevision` call was handed. */
  gated: [] as unknown[],
  /** The fixes each look of the design critic finds; none left is none. */
  critic: [] as {
    page: string
    section: string
    problem: string
    change: string
  }[][],
  /** How long ago each stall check finds the build's newest event; none left is never. */
  quiet: [] as number[],
  looks: [] as {
    request_id: string
    fact_id: string | null
    /** The fact's current version, when an edit superseded the answer's. */
    current?: string
  }[],
}
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
  SLEEP_AFTER: "5m",
  PoolExhaustedError: class PoolExhaustedError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  },
  provision: async () => {
    const ok = script.provisions.shift() ?? true
    if (!ok) {
      const { PoolExhaustedError } = await import("../src/sandbox.ts")
      throw new PoolExhaustedError("no_container_instance_available")
    }
    return { cold_start_ms: 1 }
  },
  sandboxFor: () => ({
    destroy: async () => undefined,
    exec: async (command: string) => {
      if (command.startsWith("rm -rf")) prepared.push("wipe")
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }),
  endSandbox: async () => undefined,
  tailSandbox: (sandbox: unknown) => sandbox,
  keepWarm: async () => undefined,
  takeScreenshots: async () => ({ taken: 3, ms: 1 }),
  takeWarm: async () => script.held,
  whileHeld: async () => ({ exit_code: 0, key: null, ms: 1 }),
  checkpoint: async () => ({
    taken: script.checkpoints.shift() ?? true,
    key: "k",
    bytes: 1,
    ms: 1,
  }),
  rehydrate: async () => ({ restored: true, ms: 1 }),
}))
const advanced: [string, string | undefined][] = []
/** How the developer step readied the site's disk. */
const prepared: string[] = []
const resumedOn: Record<string, unknown>[] = []
vi.mock("../src/state.ts", () => ({
  TransitionError: class TransitionError extends Error {
    constructor(
      readonly code = "",
      readonly errorClass = "validation"
    ) {
      super(code)
    }
  },
  advance: async (
    _kit: unknown,
    _ids: unknown,
    to: string,
    options?: { reason?: string; payload?: Record<string, unknown> }
  ) => {
    advanced.push([to, options?.reason])
    if (options?.payload?.fact_id) resumedOn.push(options.payload)
    return {}
  },
  parkForBudget: async () => ({}),
  lastEventAt: async () => {
    const ago = script.quiet.shift()
    return ago === undefined ? 0 : Date.now() - ago
  },
  claim: async () =>
    script.claims.shift() ?? { claimed: true, superseded: null },
}))
vi.mock("../src/revise.ts", () => ({
  SITE_ROOT: "/workspace/site",
  latestBlueprint: async () => null,
  publishedSource: async () =>
    ROW.kind === "site.revise"
      ? { revision_id: "rev-live", assignment_id: "x", source_key: "k" }
      : null,
  restoreAndMap: async () => {
    prepared.push("restore")
    return ""
  },
  mapSite: async () => {
    prepared.push("warm")
    return ""
  },
}))
vi.mock("../src/quick.ts", () => ({
  quickEdit: async () =>
    script.quickDone
      ? {
          done: true,
          base: "abc123",
          report_id: "r",
          revision_id: "v",
          model_ms: 1,
          attempts: 1,
        }
      : { done: false, reason: "apply: no match", model_ms: 1 },
}))
// The planner's bodies are driven in planner.test.ts; here only its rounds.
vi.mock("../src/planner.ts", () => ({
  PLAN_ROUNDS: 6,
  planRound: async ({ round }: { round: number }) => {
    script.planned.push(round)
    return { round, source: "model", attempts: 1 }
  },
  readDecision: async () =>
    script.decisions.length > 0 ? script.decisions.shift() : "build",
}))
// BA4's photos: one generated file, drawn over a few milliseconds, so the
// Developer is seen to start before they settle.
vi.mock("../src/photo-step.ts", () => ({
  makePhotos: async () => {
    photoStep.settled = false
    await new Promise((resolve) => setTimeout(resolve, 5))
    photoStep.settled = true
    if (photoStep.fail) throw new Error("every draw failed")
    return photoFiles
  },
}))
const photoFiles = vi.hoisted(() => ({
  generated: 1,
  fell_back: 0,
  files: [
    {
      slot_id: "hero",
      status: "generated",
      key: "generated/o/a.png",
      content_type: "image/png",
    },
  ],
}))
// BA5: the critic's rounds are driven in critic.test.ts; here each look finds
// what the path scripts, none by default.
vi.mock("../src/critic.ts", () => ({
  critiqueRound: async ({ round }: { round: number }) => ({
    round,
    fixes: script.critic.shift() ?? [],
  }),
  repairMessage: (fixes: unknown[]) => JSON.stringify({ fixes }),
}))
const sweepFailures = new Set<string>()
vi.mock("../src/retention.ts", () => ({
  retireOthers: async () => [],
  sweepOrg: async (_env: unknown, _kit: unknown, orgId: string) => {
    if (sweepFailures.has(orgId)) throw new Error("org away")
    return { parked: 1, redriven: 0, deleted: 2 }
  },
}))
// The daily domain look finds one message for org-1; its post is a step of its own.
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  sweepDomains: async (
    _env: unknown,
    _kit: unknown,
    orgId: string,
    hour: string
  ) =>
    orgId === "org-1" ? [{ key: `dom-1:sweep:${hour}`, text: "moved" }] : [],
  postStatus: async () => undefined,
}))
// The Monday look finds one message for org-1; its post is a step of its own.
vi.mock("../src/search-sync.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/search-sync.ts")>()),
  startDueSyncs: async () => 0,
  weeklyFor: async (_kit: unknown, orgId: string, now: Date) =>
    orgId === "org-1"
      ? {
          key: `search-weekly-org-1-${(await import("../src/search-sync.ts")).isoWeek(now)}`,
          message: { text: ["Search this week"] },
        }
      : null,
  postWeekly: async () => undefined,
}))
vi.mock("../src/validate.ts", () => ({
  assignmentFacts: async () => [],
  // What a quick edit's accessibility gate finds after its preview; none left is a pass.
  checkA11y: async () => {
    const outcome = script.a11y.shift() ?? "preview_ready"
    return outcome === "preview_ready"
      ? { outcome, report_id: "r" }
      : { outcome, report_id: "r", failed: [] }
  },
  // Everywhere else the accessibility gate is one `validateRevision` decides.
  validateRevision: async (
    _kit: unknown,
    _sites: unknown,
    _ids: unknown,
    input: { axe: unknown }
  ) => {
    script.gated.push(input.axe)
    const outcome = script.verdicts.shift() ?? "preview_ready"
    return outcome === "repairing"
      ? { outcome, report_id: "r", failed: [] }
      : { outcome, report_id: "r", failed: [] }
  },
}))
// The minute's scan and the jobs consumer are driven in schedule.test.ts and
// jobs.test.ts; here only which firing and which queue reach them.
const scheduler = vi.hoisted(() => ({ scans: 0, batches: [] as string[] }))
vi.mock("../src/schedule.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/schedule.ts")>()),
  scanDue: async () => {
    scheduler.scans++
    return null
  },
}))
vi.mock("../src/jobs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs.ts")>()),
  jobsBatch: async (batch: MessageBatch) => {
    scheduler.batches.push(batch.queue)
  },
}))
const { SCHEDULE_CRON } = await import("../src/schedule.ts")
const { JOBS_QUEUES } = await import("../src/jobs.ts")
const { DELIVERIES_QUEUES } = await import("../src/deliveries.ts")

const {
  AssignmentWorkflow,
  SweepWorkflow,
  SWEEP_CRON,
  sweepHour,
  default: worker,
} = await import("../src/cloudflare.ts")

type Wake = { payload: Record<string, unknown> } | "timeout"
/**
 * One wait for an answer: a nudge, or a timeout. `after` moves the clock on
 * first, as the time the wait took.
 */
type Answer = { timeout?: true; after?: number }

/** A recording step: names in order, callbacks run, sleeps skipped, waits scripted. */
function drive(wakes: Wake[], answers: Answer[] = []) {
  const names: string[] = []
  /** The timeout each answer wait was given. */
  const waits: unknown[] = []
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name)
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>
      return fn()
    },
    sleep: async (name: string) => {
      names.push(name)
    },
    waitForEvent: async (
      name: string,
      opts: { type: string; timeout?: unknown }
    ) => {
      names.push(name)
      if (opts.type === "answer" || opts.type === "blueprint") {
        waits.push(opts.timeout)
        const answer = answers.shift() ?? {}
        if (answer.after) vi.setSystemTime(Date.now() + answer.after)
        if (answer.timeout) throw new Error("timed out")
        return { payload: { request_id: "ignored", fact_id: "ignored" } }
      }
      const next = wakes.shift()
      if (!next || next === "timeout") throw new Error("timed out")
      return next
    },
  }
  const env = {
    HYPERDRIVE: { connectionString: "postgres://stub" },
  } as unknown as Env
  const run = () =>
    new AssignmentWorkflow({} as never, env).run(
      {
        payload: { org_id: ROW.orgId, assignment_id: ROW.id },
        timestamp: new Date(),
      } as never,
      step as never
    )
  return { names, waits, run }
}

const HOUR = 60 * 60 * 1000
const unanswered = { request_id: "q", fact_id: null }

const completion: Wake = {
  payload: { kind: "completion", report_id: "r", revision_id: "v" },
}
const information: Wake = {
  payload: { kind: "information", request_id: "q" },
}
const budget: Wake = { payload: { kind: "budget", cap_usd: 1, spent_usd: 1 } }
const interrupted: Wake = {
  payload: { kind: "interrupted", reason: "stream" },
}
const unreported: Wake = {
  payload: { kind: "unreported", reason: "developer.no_report" },
}
const cannotStart: Wake = {
  payload: { kind: "start_failed", reason: "FacadeError" },
}

const expected: Record<string, string[]> = steps.AssignmentWorkflow

type Setup = {
  claims?: typeof script.claims
  provisions?: boolean[]
  verdicts?: string[]
  a11y?: string[]
  checkpoints?: boolean[]
  answers?: Answer[]
  looks?: typeof script.looks
  origin?: "owner"
  lane?: typeof script.lane
  quickDone?: boolean
  decisions?: typeof script.decisions
  skipReview?: boolean
  critic?: typeof script.critic
  quiet?: number[]
  photosFail?: boolean
}
const full = { lane: "full" }
const copy = { lane: "quick", change_kind: "copy" }
const FIX = {
  page: "home",
  section: "Hero",
  problem: "The headline runs to nine words.",
  change: "Cut it to five.",
}
const paths: [string, Wake[], Setup, { outcome: string }][] = [
  ["build", [completion], {}, { outcome: "preview_ready" }],
  // An owner's build opens its own review once the sandbox is gone.
  [
    "owner build",
    [completion],
    { origin: "owner" },
    { outcome: "preview_ready" },
  ],
  // The first look finds no answer yet; the nudge sends it to look again.
  [
    "information round trip",
    [information, completion],
    { looks: [unanswered] },
    { outcome: "preview_ready" },
  ],
  // A nudge for an earlier question, or a repeat: one more look, then a wait.
  [
    "a stale nudge, then the answer",
    [information, completion],
    { looks: [unanswered, unanswered] },
    { outcome: "preview_ready" },
  ],
  [
    "gate failure repaired",
    [completion, completion],
    { verdicts: ["repairing"] },
    { outcome: "preview_ready" },
  ],
  [
    "gate failure ends failed",
    [completion],
    { verdicts: ["failed"] },
    { outcome: "failed" },
  ],
  ["budget park", [budget], {}, { outcome: "blocked_on_approval" }],
  // QE4: one model call and one build, reported without a Developer.
  [
    "quick edit",
    [],
    { origin: "owner", lane: copy },
    { outcome: "preview_ready" },
  ],
  // The edit did not apply twice: the Developer takes it at the section role.
  [
    "quick edit handed on",
    [completion],
    { origin: "owner", lane: copy, quickDone: false },
    { outcome: "preview_ready" },
  ],
  // The edit built but failed a gate: its files go back, then the same.
  [
    "quick edit failed a gate",
    [completion],
    { origin: "owner", lane: copy, verdicts: ["repairing"] },
    { outcome: "preview_ready" },
  ],
  // A quick edit runs axe once its preview exists; a failure there goes to
  // the section lane, whose second preview waits on axe.
  [
    "accessibility failed after a quick edit",
    [completion],
    { origin: "owner", lane: copy, a11y: ["repairing"] },
    { outcome: "preview_ready" },
  ],
  // The site went to a newer edit before axe could run: this build stops.
  [
    "superseded before accessibility",
    [],
    { origin: "owner", lane: copy, a11y: ["stopped"] },
    { outcome: "stopped" },
  ],
  [
    "section change",
    [completion],
    { origin: "owner", lane: { lane: "quick", change_kind: "section" } },
    { outcome: "preview_ready" },
  ],
  [
    "interrupted then resumed",
    [interrupted, completion],
    {},
    { outcome: "preview_ready" },
  ],
  [
    "interrupted past the resume budget",
    [interrupted, interrupted, interrupted],
    {},
    { outcome: "failed" },
  ],
  // A whole lead turn with nothing in the log: the build is failed as stalled.
  ["developer went quiet", ["timeout"], {}, { outcome: "failed" }],
  // The lead logged ten minutes ago, so it is still at work: wait again.
  [
    "developer still working past a wait",
    ["timeout", completion],
    { quiet: [10 * 60 * 1000] },
    { outcome: "preview_ready" },
  ],
  // The lead's turn ended with no accepted report: fail now, not later.
  ["developer ended without a report", [unreported], {}, { outcome: "failed" }],
  // The lead threw before its first turn: fail now, with no resume.
  ["developer could not start", [cannotStart], {}, { outcome: "failed" }],
  [
    "superseded a preview",
    [completion],
    { claims: [{ claimed: true, superseded: SUPERSEDED }] },
    { outcome: "preview_ready" },
  ],
  [
    "site busy then claimed",
    [completion],
    { claims: [{ claimed: false, superseded: null }] },
    { outcome: "preview_ready" },
  ],
  [
    "pool full then provisioned",
    [completion],
    { provisions: [false] },
    { outcome: "preview_ready" },
  ],
  // Failing is what releases the site lock to the next build.
  [
    "pool never frees",
    [],
    { provisions: Array(20).fill(false) },
    { outcome: "failed" },
  ],
  // The container slept before the block reached the checkpoint, so the site
  // is gone and no answer can bring it back. Failing here is what releases
  // the site lock; before this path existed the instance errored holding it.
  [
    "checkpoint found the site gone",
    [information],
    { checkpoints: [false] },
    { outcome: "failed" },
  ],
  // ADR-038: a first build plans; the console's builds from the plan at once.
  ["planned build", [completion], { lane: full }, { outcome: "preview_ready" }],
  // The photo step throws for good: one step logs `site.photos_failed`, which
  // ends write_pages's wait, and the build goes on without the photos.
  [
    "photos failed",
    [completion],
    { lane: full, photosFail: true },
    { outcome: "preview_ready" },
  ],
  // BA5: the critic finds two things, the lead is sent back once and the
  // second look finds them fixed.
  [
    "design critique repaired",
    [completion, completion],
    { lane: full, critic: [[FIX, FIX], []] },
    { outcome: "preview_ready" },
  ],
  // An owner's waits on the card: the first look finds no decision, the
  // nudge sends it to look again and finds "Build it".
  [
    "owner reviews the plan",
    [completion],
    { origin: "owner", lane: full, decisions: [null, "build"] },
    { outcome: "preview_ready" },
  ],
  [
    "owner changes the plan",
    [completion],
    { origin: "owner", lane: full, decisions: ["change", "build"] },
    { outcome: "preview_ready" },
  ],
  [
    "owner skipped the review",
    [completion],
    { origin: "owner", lane: full, skipReview: true },
    { outcome: "preview_ready" },
  ],
  [
    "nobody decided on the plan",
    [],
    {
      origin: "owner",
      lane: full,
      decisions: Array(29).fill(null),
      answers: Array(28).fill({ timeout: true, after: 6 * HOUR }),
    },
    { outcome: "failed" },
  ],
  [
    "nobody answered",
    [information],
    // 28 six-hour waits use up the seven days; the 29th look fails the round.
    {
      looks: Array(29).fill(unanswered),
      answers: Array(28).fill({ timeout: true, after: 6 * HOUR }),
    },
    {
      outcome: "failed",
    },
  ],
]

beforeEach(() => {
  vi.setSystemTime(new Date("2026-09-27T09:00:00Z"))
  script.looks = []
  dispatched.length = 0
  resumedOn.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the assignment Workflow's step names", () => {
  it.each(paths)("%s", async (path, wakes, setup, outcome) => {
    script.looks = [...(setup.looks ?? [])]
    script.claims = [...(setup.claims ?? [])]
    script.provisions = [...(setup.provisions ?? [])]
    script.verdicts = [...(setup.verdicts ?? [])]
    script.a11y = [...(setup.a11y ?? [])]
    script.checkpoints = [...(setup.checkpoints ?? [])]
    script.origin = setup.origin ?? "console"
    script.lane = setup.lane ?? {}
    script.quickDone = setup.quickDone ?? true
    script.decisions = [...(setup.decisions ?? [])]
    script.skipReview = setup.skipReview ?? false
    script.planned = []
    script.critic = [...(setup.critic ?? [])]
    script.quiet = [...(setup.quiet ?? [])]
    photoStep.fail = setup.photosFail ?? false
    photoStep.appended.length = 0
    const { names, run } = drive([...wakes], [...(setup.answers ?? [])])
    expect(await run()).toMatchObject(outcome)
    expect(names).toEqual(expected[path])
    expect(photoStep.appended.includes("site.photos_failed")).toBe(
      Boolean(setup.photosFail)
    )
  })

  it("keeps a round's deadline through a stale nudge, and resumes on its answer", async () => {
    script.verdicts = ["preview_ready"]
    // Round 1 is answered at once. Round 2 waits out 27 six-hour timeouts, so
    // six hours are left; five hours in, a nudge for round 1's question comes.
    // It costs one look, the next wait gets only the hour left, and the
    // answer's nudge ends the round.
    script.looks = [
      { request_id: "q", fact_id: "f" },
      ...Array(29).fill(unanswered),
      { request_id: "q", fact_id: "f2" },
    ]
    const { names, waits, run } = drive(
      [information, information, completion],
      [
        ...Array(27).fill({ timeout: true, after: 6 * HOUR }),
        { after: 5 * HOUR },
        {},
      ]
    )
    expect(await run()).toMatchObject({ outcome: "preview_ready" })
    expect(names.filter((n) => n.startsWith("deadline"))).toEqual([
      "deadline 1",
      "deadline 2",
    ])
    expect(waits).toEqual([...Array(28).fill(6 * HOUR), HOUR])
    expect(resumedOn.map((p) => p.fact_id)).toEqual(["f", "f2"])
  })

  it("resumes on the fact's current version when the owner edited it", async () => {
    script.verdicts = ["preview_ready"]
    script.looks = [{ request_id: "q", fact_id: "f", current: "f-edited" }]
    await drive([information, completion]).run()
    expect(resumedOn).toEqual([{ request_id: "q", fact_id: "f-edited" }])
  })

  it("finds an answer whose nudge was lost at the next look", async () => {
    script.verdicts = ["preview_ready"]
    script.looks = [unanswered, { request_id: "q", fact_id: "f" }]
    const { names, waits, run } = drive(
      [information, completion],
      [{ timeout: true, after: 6 * HOUR }]
    )
    expect(await run()).toMatchObject({ outcome: "preview_ready" })
    expect(waits).toEqual([6 * HOUR])
    expect(names).toContain("resume 1")
  })

  it("starts a section change on the section role and steps up to build once", async () => {
    script.lane = { lane: "quick", change_kind: "section" }
    script.verdicts = ["repairing", "repairing", "preview_ready"]
    dispatched.length = 0
    await drive([completion, completion, completion]).run()
    script.lane = {}
    const [first, ...repairs] = dispatched as {
      message: { attributes?: Record<string, string> }
      initialData?: { role?: string }
    }[]
    expect(first?.initialData?.role).toBe("quick_section")
    expect(repairs.map((r) => r.message.attributes?.role)).toEqual([
      "build",
      undefined,
    ])
  })

  it("opens a review for an owner's preview only", async () => {
    const reviews = async (origin: "owner" | "console", verdict: string) => {
      script.reviews = 0
      script.verdicts = [verdict]
      script.origin = origin
      await drive([completion]).run()
      return script.reviews
    }
    expect(await reviews("owner", "preview_ready")).toBe(1)
    expect(await reviews("console", "preview_ready")).toBe(0)
    expect(await reviews("owner", "failed")).toBe(0)
  })

  it("hands an owner's goal to the Developer only inside a tainted signal", async () => {
    const first = async (origin: "owner" | "console") => {
      dispatched.length = 0
      script.verdicts = ["preview_ready"]
      script.origin = origin
      await drive([completion]).run()
      return dispatched[0] as {
        message: unknown
        initialData: { goal: string; goal_tainted: boolean }
      }
    }
    const owner = await first("owner")
    expect(owner.message).toEqual({
      kind: "signal",
      type: "site.change_requested",
      body: ROW.goal,
      attributes: { taint: "untrusted_input" },
    })
    expect(owner.initialData.goal_tainted).toBe(true)
    // The console's build is dispatched as it always was.
    const console_ = await first("console")
    expect(console_.message).toBe(
      `Build the site from the canonical facts. ${ROW.goal}`
    )
    expect(console_.initialData.goal_tainted).toBe(false)
  })

  it("starts a planned build's Developer while its photos draw, with none in its brief", async () => {
    const admitted = async (lane: typeof script.lane) => {
      dispatched.length = 0
      script.verdicts = ["preview_ready"]
      script.lane = lane
      await drive([completion]).run()
      return dispatched[0] as unknown as {
        photosSettled: boolean
        initialData: { photos?: unknown[] }
      }
    }
    // write_pages places each photo as it lands; the brief names none.
    const planned = await admitted(full)
    expect(planned.photosSettled).toBe(false)
    expect(planned.initialData.photos).toBeUndefined()
    // The run waited for the step before it ended.
    expect(photoStep.settled).toBe(true)
    expect((await admitted({})).initialData.photos).toBeUndefined()
  })

  it("sends the lead back once with the critic's fixes, and not at all for a build that did not plan", async () => {
    const signals = () =>
      dispatched
        .map((d) => d.message as { type?: string; body?: string })
        .filter((m) => m.type === "design.critique")
    script.lane = full
    // The second look still sees the fix: no second repair, the gates decide.
    script.critic = [[FIX], [FIX]]
    await drive([completion, completion]).run()
    expect(signals()).toHaveLength(1)
    expect(JSON.parse(signals()[0]?.body ?? "")).toEqual({ fixes: [FIX] })
    script.lane = {}
    script.critic = [[FIX]]
    const unplanned = drive([completion])
    await unplanned.run()
    expect(unplanned.names.some((n) => n.startsWith("critique"))).toBe(false)
  })

  it("hands the gates an axe run from before the preview: the critic's step when planned, its own step otherwise", async () => {
    script.lane = full
    script.critic = [[]]
    script.gated = []
    const planned = drive([completion])
    await planned.run()
    expect(planned.names.some((n) => n.startsWith("a11y"))).toBe(false)
    expect(script.gated).toEqual([{ exit_code: 0, key: null, ms: 1 }])
    script.lane = {}
    script.gated = []
    const quick = drive([completion])
    await quick.run()
    expect(quick.names.indexOf("a11y 1")).toBeLessThan(
      quick.names.indexOf("gates 1")
    )
    expect(quick.names.indexOf("a11y 1")).toBeGreaterThan(
      quick.names.indexOf("validating 1")
    )
    expect(script.gated).toEqual([{ exit_code: 0, key: null, ms: 1 }])
  })

  it("runs a quick edit's axe after its preview, and the section lane's before", async () => {
    script.lane = copy
    script.a11y = ["repairing"]
    script.gated = []
    const quick = drive([completion])
    await quick.run()
    // The quick edit's gates are handed no axe run; the section lane's are.
    expect(script.gated).toEqual(["later", { exit_code: 0, key: null, ms: 1 }])
    expect(quick.names.indexOf("a11y 1")).toBeGreaterThan(
      quick.names.indexOf("gates 1")
    )
    expect(quick.names.indexOf("a11y 2")).toBeLessThan(
      quick.names.indexOf("gates 2")
    )
    // The Developer is told what axe found.
    expect(dispatched.map((d) => JSON.stringify(d))).toEqual(
      expect.arrayContaining([expect.stringContaining("validation.failed")])
    )
    script.lane = {}
  })

  it("leaves an owner's build as it ended when it left preview_ready before the review", async () => {
    script.verdicts = ["preview_ready"]
    script.origin = "owner"
    // Superseded or cancelled between the gates and the review step.
    script.reviewRefusal = "assignment.not_previewable"
    const { names, run } = drive([completion])
    expect(await run()).toMatchObject({ outcome: "preview_ready" })
    expect(names).toEqual(expected["owner build"])
    // Any other refusal is still final.
    script.reviewRefusal = "revision.not_preview"
    await expect(drive([completion]).run()).rejects.toThrow()
    script.reviewRefusal = null
  })

  it("names every path the file lists", () => {
    expect(Object.keys(expected).sort()).toEqual(
      [
        "build",
        "owner build",
        "information round trip",
        "gate failure repaired",
        "gate failure ends failed",
        "budget park",
        "interrupted then resumed",
        "interrupted past the resume budget",
        "developer went quiet",
        "developer still working past a wait",
        "developer ended without a report",
        "developer could not start",
        "superseded a preview",
        "site busy then claimed",
        "pool full then provisioned",
        "pool never frees",
        "checkpoint found the site gone",
        "nobody answered",
        "a stale nudge, then the answer",
        "quick edit",
        "quick edit handed on",
        "quick edit failed a gate",
        "accessibility failed after a quick edit",
        "superseded before accessibility",
        "section change",
        "planned build",
        "photos failed",
        "design critique repaired",
        "owner reviews the plan",
        "owner changes the plan",
        "owner skipped the review",
        "nobody decided on the plan",
      ].sort()
    )
  })
})

describe("a Developer that stops without a report", () => {
  it("fails as developer.no_report when its turn ended with nothing that woke the build", async () => {
    advanced.length = 0
    expect(await drive([unreported]).run()).toMatchObject({
      outcome: "failed",
    })
    expect(advanced.at(-1)).toEqual(["failed", "developer.no_report"])
  })

  it("fails as developer.start_failed when the lead could not start, without resuming it", async () => {
    advanced.length = 0
    expect(await drive([cannotStart]).run()).toMatchObject({
      outcome: "failed",
    })
    expect(advanced.at(-1)).toEqual(["failed", "developer.start_failed"])
  })

  it("fails as developer.stalled only once a whole lead turn has nothing in the log", async () => {
    advanced.length = 0
    // Forty minutes quiet: still inside a turn, so it waits again; the next
    // check finds the full window empty.
    script.quiet = [40 * 60 * 1000, 45 * 60 * 1000]
    const { names, run } = drive(["timeout", "timeout"])
    expect(await run()).toMatchObject({ outcome: "failed" })
    expect(names).toContain("developer 1.2")
    expect(advanced.at(-1)).toEqual(["failed", "developer.stalled"])
  })
})

describe("an interrupted Developer run", () => {
  const stopped = (reason: string) =>
    ({ payload: { kind: "interrupted", reason } }) as Wake
  const resumes = () =>
    dispatched
      .map(
        (d) =>
          d.message as { type?: string; attributes?: Record<string, string> }
      )
      .filter((m) => m.type === "run.interrupted")
      .map((m) => m.attributes ?? {})

  it("fails as provider.unavailable after two resumes, the second on the fallback model", async () => {
    dispatched.length = 0
    advanced.length = 0
    const { run } = drive([
      stopped("stream broke"),
      stopped("stream broke"),
      stopped("stream broke"),
    ])
    expect(await run()).toMatchObject({ outcome: "failed" })
    expect(resumes()).toEqual([
      { attempt: "1" },
      { attempt: "2", model: "fallback", reason: "stream broke" },
    ])
    expect(advanced.at(-1)).toEqual(["failed", "provider.unavailable"])
  })

  it.each(["sandbox.updating", "tool.repeating_failure"])(
    "fails as %s and never asks for the fallback model",
    async (reason) => {
      dispatched.length = 0
      advanced.length = 0
      const { run } = drive([stopped(reason), stopped(reason), stopped(reason)])
      expect(await run()).toMatchObject({ outcome: "failed" })
      expect(resumes()).toEqual([{ attempt: "1" }, { attempt: "2" }])
      expect(advanced.at(-1)).toEqual(["failed", reason])
    }
  )
})

describe("the sweep Workflow's step names", () => {
  const sweep = async (
    orgs: number,
    failing: string[] = [],
    hour = "2026091612"
  ) => {
    orgList.length = 0
    for (let i = 1; i <= orgs; i++) orgList.push(`org-${i}`)
    sweepFailures.clear()
    for (const id of failing) sweepFailures.add(id)
    const names: string[] = []
    const step = {
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name)
        const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>
        return fn()
      },
      sleep: async (name: string) => {
        names.push(name)
      },
    }
    const env = {
      HYPERDRIVE: { connectionString: "postgres://stub" },
    } as unknown as Env
    const totals = await new SweepWorkflow({} as never, env).run(
      { payload: { hour } } as never,
      step as never
    )
    return { names, totals }
  }

  it("sweeps every org in chunks and counts what each did", async () => {
    const one = await sweep(2)
    expect(one.names).toEqual(steps.SweepWorkflow["one chunk"])
    expect(one.totals).toEqual({
      orgs: 2,
      parked: 2,
      redriven: 0,
      deleted: 4,
      failed: 0,
    })
    const two = await sweep(51)
    expect(two.names).toEqual(steps.SweepWorkflow["two chunks"])
    expect(two.totals.orgs).toBe(51)
  })

  it("counts an org that throws and keeps sweeping the rest", async () => {
    const { totals } = await sweep(51, ["org-1", "org-51"])
    expect(totals).toEqual({
      orgs: 51,
      parked: 49,
      redriven: 0,
      deleted: 98,
      failed: 2,
    })
  })

  it("looks at live domains once a day, after the orgs, and posts each message in its own step", async () => {
    const daily = await sweep(51, [], "2026091606")
    expect(daily.names).toEqual(steps.SweepWorkflow["daily domains"])
    expect(daily.totals.orgs).toBe(51)
  })

  it("sends the weekly search message on Monday at 07 UTC, each post a step of its own", async () => {
    const monday = await sweep(51, [], "2026092107")
    expect(monday.names).toEqual(steps.SweepWorkflow["weekly search"])
    expect((await sweep(51, [], "2026092207")).names).not.toContain("weekly 1")
  })

  it("names the hour the way the cron does", () => {
    expect(sweepHour(Date.UTC(2026, 8, 16, 12, 0, 5))).toBe("2026091612")
  })
})

describe("the scheduled handler", () => {
  const config = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  )
  async function fire(cron: string, healthUrls?: string) {
    const created = vi.fn(async () => ({}))
    const fetched = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetched)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      await worker.scheduled(
        {
          cron,
          scheduledTime: Date.UTC(2026, 8, 16, 12),
        } as ScheduledController,
        {
          SWEEPS: { create: created },
          HEALTH_URLS: healthUrls,
        } as unknown as Env
      )
    } finally {
      vi.unstubAllGlobals()
      log.mockRestore()
    }
    return {
      created,
      fetched,
      urls: fetched.mock.calls.map((c) => String((c as unknown[])[0])),
    }
  }

  it("sweeps and checks uptime on one hourly firing", async () => {
    const { created, urls } = await fire(
      "0 * * * *",
      "https://api.example.invalid/health"
    )
    expect(created).toHaveBeenCalledWith({
      id: "sweep-2026091612",
      params: { hour: "2026091612" },
    })
    // The health URL and one verification file the router serves.
    expect(urls).toEqual([
      "https://api.example.invalid/health",
      "https://a-stg.remeai.co.uk/google1a.html",
    ])
  })

  it("only sweeps where no health URLs are set, as on staging", async () => {
    const { created, urls } = await fire("0 * * * *")
    expect(created).toHaveBeenCalledOnce()
    expect(urls).toEqual([])
  })

  it("runs nothing on a cron no job claims", async () => {
    const { created, fetched } = await fire(
      "*/5 * * * *",
      "https://api.example.invalid/health"
    )
    expect(created).not.toHaveBeenCalled()
    expect(fetched).not.toHaveBeenCalled()
    expect(scheduler.scans).toBe(0)
  })

  it("scans for due jobs every minute, and only then", async () => {
    scheduler.scans = 0
    const { created, fetched } = await fire(
      "* * * * *",
      "https://api.example.invalid/health"
    )
    expect(scheduler.scans).toBe(1)
    expect(created).not.toHaveBeenCalled()
    expect(fetched).not.toHaveBeenCalled()
    await fire("0 * * * *")
    expect(scheduler.scans).toBe(1)
  })

  it("schedules exactly the crons the handler matches", () => {
    // The handler matches the string exactly, so the config must spell it the same.
    const crons = [...config.matchAll(/"crons": (\[[^\]]*\])/g)].map(
      (m) => JSON.parse(m[1] ?? "[]") as string[]
    )
    const jobs = [...new Set([SWEEP_CRON, UPTIME_CRON])]
    expect(crons).toEqual([
      [SWEEP_CRON, SCHEDULE_CRON],
      [...jobs, SCHEDULE_CRON],
    ])
  })
})

describe("the queue handler", () => {
  const batch = (queue: string) =>
    ({ queue, messages: [] }) as unknown as MessageBatch

  it("hands the jobs queue's batches to the jobs consumer in both environments", async () => {
    scheduler.batches.length = 0
    for (const queue of JOBS_QUEUES) await worker.queue(batch(queue), {} as Env)
    expect(scheduler.batches).toEqual(JOBS_QUEUES)
  })

  it("acks nothing from a queue it does not consume", async () => {
    await expect(
      worker.queue(batch("reme-jobs-dlq"), {} as Env)
    ).rejects.toThrow("no consumer")
  })

  it("consumes exactly the queues the config names", () => {
    const config = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8"
    )
    const consumed = [
      ...config.matchAll(/\{\s*"queue": "([^"]+)",\s*"max_retries"/g),
    ].map((m) => m[1])
    expect(consumed.toSorted()).toEqual(
      [...JOBS_QUEUES, ...DELIVERIES_QUEUES].toSorted()
    )
  })
})

// QE2: a revise whose site's sandbox is still warm with the revision it
// starts from skips the restore; any other disk is replaced.
describe("the disk a build starts on", () => {
  it.each([
    ["site.revise", "rev-live", "warm"],
    ["site.revise", "rev-older", "restore"],
    ["site.revise", null, "restore"],
    ["site.build", "rev-live", "wipe"],
  ])("%s on a sandbox holding %s: %s", async (kind, held, outcome) => {
    ROW.kind = kind
    script.held = held
    script.verdicts = ["preview_ready"]
    prepared.length = 0
    try {
      await drive([completion]).run()
      expect(prepared).toEqual([outcome])
    } finally {
      ROW.kind = "site.build"
      script.held = null
    }
  })

  // Back to back: the preview this edit superseded is still taking its
  // screenshots, so it has not marked the disk, but the disk is its revision.
  it("maps the disk a superseded preview left, before that preview marks it", async () => {
    ROW.kind = "site.revise"
    script.claims = [{ claimed: true, superseded: SUPERSEDED }]
    script.verdicts = ["preview_ready"]
    prepared.length = 0
    try {
      await drive([completion]).run()
      expect(prepared).toEqual(["warm"])
    } finally {
      ROW.kind = "site.build"
    }
  })
})
