import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))
// The publisher's step bodies are driven for real, against a database, in
// publish.test.ts; here only the assignment paths run.
vi.mock("../src/publish.ts", () => ({
  PROBE_MINUTES: [0, 2, 5, 10],
  activate: async () => ({}),
  probeHost: async () => ({ ok: true }),
  readTarget: async () => ({}),
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
const dispatched: { message: unknown }[] = []
// The real module underneath, so the gate reasons the Workflow matches on are
// the ones the gate actually emits. Only the agent entry point is stood in for.
vi.mock("@workspace/facade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/facade")>()),
  AgentInstanceExistsError,
  init: () => ({
    dispatch: async (request: { message: unknown }) => {
      dispatched.push(request)
      return { submissionId: "s" }
    },
  }),
}))

const ROW = {
  id: "10000001-0000-4000-8000-000000000001",
  orgId: "10000001-0000-4000-8000-000000000000",
  goal: "probe",
  acceptanceCriteria: [],
  state: "implementing",
  version: 3,
}
const orgList: string[] = []
vi.mock("@workspace/db", () => ({
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
  }),
  takeSnapshot: async () => ({}),
  issueSpec: async () => ({}),
}))

const SUPERSEDED = "10000001-0000-4000-8000-00000000aaaa"
const script = {
  claims: [] as { claimed: boolean; superseded: string | null }[],
  provisions: [] as boolean[],
  verdicts: [] as string[],
  checkpoints: [] as boolean[],
  origin: "console" as "owner" | "console",
  reviews: 0,
  reviewRefusal: null as string | null,
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
  sandboxFor: () => ({ destroy: async () => undefined }),
  endSandbox: async () => undefined,
  checkpoint: async () => ({
    taken: script.checkpoints.shift() ?? true,
    key: "k",
    bytes: 1,
    ms: 1,
  }),
  rehydrate: async () => ({ restored: true, ms: 1 }),
}))
const advanced: [string, string | undefined][] = []
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
  appendEvent: async () => "e",
  parkForBudget: async () => ({}),
  claim: async () =>
    script.claims.shift() ?? { claimed: true, superseded: null },
}))
vi.mock("../src/revise.ts", () => ({
  publishedSource: async () => null,
  restoreAndMap: async () => "",
}))
const sweepFailures = new Set<string>()
vi.mock("../src/retention.ts", () => ({
  retireOthers: async () => [],
  sweepOrg: async (_env: unknown, _kit: unknown, orgId: string) => {
    if (sweepFailures.has(orgId)) throw new Error("org away")
    return { parked: 1, redriven: 0, deleted: 2 }
  },
}))
vi.mock("../src/validate.ts", () => ({
  assignmentFacts: async () => [],
  validateRevision: async () => {
    const outcome = script.verdicts.shift() ?? "preview_ready"
    return outcome === "repairing"
      ? { outcome, report_id: "r", failed: [] }
      : { outcome, report_id: "r", failed: [] }
  },
}))

const { AssignmentWorkflow, SweepWorkflow, sweepHour } = await import(
  "../src/cloudflare.ts"
)

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
      if (opts.type === "answer") {
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
      { payload: { org_id: ROW.orgId, assignment_id: ROW.id } } as never,
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

const expected: Record<string, string[]> = steps.AssignmentWorkflow

type Setup = {
  claims?: typeof script.claims
  provisions?: boolean[]
  verdicts?: string[]
  checkpoints?: boolean[]
  answers?: Answer[]
  looks?: typeof script.looks
  origin?: "owner"
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
  ["developer timed out", ["timeout"], {}, { outcome: "failed" }],
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
  // The container slept before the block reached the checkpoint, so the site
  // is gone and no answer can bring it back. Failing here is what releases
  // the site lock; before this path existed the instance errored holding it.
  [
    "checkpoint found the site gone",
    [information],
    { checkpoints: [false] },
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
    script.checkpoints = [...(setup.checkpoints ?? [])]
    script.origin = setup.origin ?? "console"
    const { names, run } = drive([...wakes], [...(setup.answers ?? [])])
    expect(await run()).toMatchObject(outcome)
    expect(names).toEqual(expected[path])
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
        "developer timed out",
        "superseded a preview",
        "site busy then claimed",
        "pool full then provisioned",
        "checkpoint found the site gone",
        "nobody answered",
        "a stale nudge, then the answer",
      ].sort()
    )
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
  const sweep = async (orgs: number, failing: string[] = []) => {
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
      { payload: { hour: "2026091612" } } as never,
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

  it("names the hour the way the cron does", () => {
    expect(sweepHour(Date.UTC(2026, 8, 16, 12, 0, 5))).toBe("2026091612")
  })
})
