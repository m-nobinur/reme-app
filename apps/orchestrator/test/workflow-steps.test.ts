import { describe, expect, it, vi } from "vitest"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * Open item 46 (ADR-032): every path through the assignment Workflow, driven
 * with a recording step and every collaborator stood in for, so the ordered
 * step names are a committed fact the staging deploy can compare. The
 * publisher's paths are recorded the same way in publish.test.ts, against a
 * database, and read the same file.
 */

vi.mock("cloudflare:workers", () => ({
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
vi.mock("@workspace/facade", () => ({
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
  creationChoices: async () => ({ withhold: [], model: "A" }),
  takeSnapshot: async () => ({}),
  issueSpec: async () => ({}),
}))

const SUPERSEDED = "10000001-0000-4000-8000-00000000aaaa"
const script = {
  claims: [] as { claimed: boolean; superseded: string | null }[],
  provisions: [] as boolean[],
  verdicts: [] as string[],
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
  checkpoint: async () => ({ key: "k", bytes: 1, ms: 1 }),
  rehydrate: async () => ({ restored: true, ms: 1 }),
}))
const advanced: [string, string | undefined][] = []
vi.mock("../src/state.ts", () => ({
  TransitionError: class TransitionError extends Error {
    errorClass = "validation"
  },
  advance: async (
    _kit: unknown,
    _ids: unknown,
    to: string,
    options?: { reason?: string }
  ) => {
    advanced.push([to, options?.reason])
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

/** A recording step: names in order, callbacks run, sleeps skipped, waits scripted. */
function drive(wakes: Wake[], answers: Record<string, unknown>[] = []) {
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
    waitForEvent: async (name: string, opts: { type: string }) => {
      names.push(name)
      if (opts.type === "answer") {
        return { payload: answers.shift() ?? { request_id: "q", fact_id: "f" } }
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
  return { names, run }
}

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
}
const paths: [string, Wake[], Setup, { outcome: string }][] = [
  ["build", [completion], {}, { outcome: "preview_ready" }],
  [
    "information round trip",
    [information, completion],
    {},
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
]

describe("the assignment Workflow's step names", () => {
  it.each(paths)("%s", async (path, wakes, setup, outcome) => {
    script.claims = [...(setup.claims ?? [])]
    script.provisions = [...(setup.provisions ?? [])]
    script.verdicts = [...(setup.verdicts ?? [])]
    const { names, run } = drive([...wakes])
    expect(await run()).toMatchObject(outcome)
    expect(names).toEqual(expected[path])
  })

  it("names every path the file lists", () => {
    expect(Object.keys(expected).sort()).toEqual(
      [
        "build",
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
