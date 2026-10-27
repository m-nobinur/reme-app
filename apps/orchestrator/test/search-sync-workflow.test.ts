import { beforeEach, describe, expect, it, vi } from "vitest"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * `SearchSyncWorkflow`'s paths, driven with a recording step and its bodies
 * scripted, so the step names are the committed list in workflow-steps.json.
 * The bodies themselves are tested in search-sync.test.ts.
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
  NonRetryableError: class extends Error {},
}))

const script = vi.hoisted(() => ({
  calls: [] as string[],
  pullError: null as Error | null,
  stale: null as string | null,
  healthy: true,
  say: null as { key: string; text: string } | null,
}))
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
}))
// The engine is tested against a database in probe.test.ts; here it is the step it runs in.
vi.mock("../src/probe.ts", () => ({
  probe: async (
    step: { do: (...args: unknown[]) => Promise<unknown> },
    name: string,
    _env: unknown,
    _target: unknown,
    read: (kit: unknown) => Promise<{ result: object }>,
    config: unknown
  ) =>
    step.do(name, config, async () => ({
      ...(await read({})).result,
      ...(script.say && { say: script.say }),
    })),
}))
vi.mock("../src/search.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/search.ts")>()),
  tell: async (_kit: unknown, _org: string, key: string) => {
    script.calls.push(`tell ${key}`)
  },
}))
vi.mock("../src/search-sync.ts", () => ({
  checkGrant: async () => ({ result: { healthy: script.healthy } }),
  syncTargets: async () => [
    "https://a.example.test/",
    "https://b.example.test/",
  ],
  pullProperty: async (...args: unknown[]) => {
    if (script.pullError) throw script.pullError
    script.calls.push(`pull ${String(args[3])}`)
    return args[3] === script.stale
      ? { days: 0, pairs: 0, stale: true }
      : { days: 30, pairs: 4 }
  },
  inspectPages: async (...args: unknown[]) => {
    script.calls.push(`inspect ${String(args[3])}`)
    return 0
  },
}))

const { GoogleError, NeedsReauth } = await import("../src/google.ts")
const { NonRetryableError } = await import("cloudflare:workflows")
const { SearchSyncWorkflow, SYNC_RETRIES } = await import(
  "../src/search-workflow.ts"
)

async function drive() {
  const names: string[] = []
  const configs: Record<string, unknown> = {}
  const step = {
    do: async (name: string, config: unknown, fn: () => Promise<unknown>) => {
      names.push(name)
      configs[name] = config
      return fn()
    },
  }
  const result = await new SearchSyncWorkflow({} as never, {} as never).run(
    { payload: { org_id: "org" } } as never,
    step as never
  )
  return { names, result, configs }
}

beforeEach(() => {
  script.calls.length = 0
  script.pullError = null
  script.stale = null
  script.healthy = true
  script.say = null
})

describe("the daily search sync", () => {
  it("pulls and inspects each verified property in turn", async () => {
    const { names, result, configs } = await drive()
    expect(names).toEqual(steps.SearchSyncWorkflow.synced)
    expect(result).toEqual({ outcome: "synced", properties: 2 })
    expect(script.calls).toEqual([
      "pull https://a.example.test/",
      "inspect https://a.example.test/",
      "pull https://b.example.test/",
      "inspect https://b.example.test/",
    ])
    expect(configs["pull 1"]).toBe(SYNC_RETRIES)
  })

  it("skips a property Google refused and pulls the next", async () => {
    script.stale = "https://a.example.test/"
    const { names, result } = await drive()
    expect(names).toEqual(steps.SearchSyncWorkflow.stale)
    expect(result).toEqual({ outcome: "synced", properties: 2 })
    expect(script.calls).toEqual([
      "pull https://a.example.test/",
      "pull https://b.example.test/",
      "inspect https://b.example.test/",
    ])
  })

  it("stops at a revoked token without failing", async () => {
    script.pullError = new NeedsReauth()
    const { names, result } = await drive()
    expect(names).toEqual(steps.SearchSyncWorkflow["needs reauth"])
    expect(result).toEqual({ outcome: "needs_reauth" })
  })

  it("says a lost permission once and ends the day", async () => {
    script.healthy = false
    script.say = { key: "task:t:permissions:abc", text: "Google needs more" }
    const { names, result } = await drive()
    expect(names).toEqual(steps.SearchSyncWorkflow["lost permission"])
    expect(result).toEqual({ outcome: "needs_permission" })
    expect(script.calls).toEqual(["tell task:t:permissions:abc"])
  })

  it("retries only Google's outage", async () => {
    script.pullError = new GoogleError("google.unavailable", 503)
    await expect(drive()).rejects.toThrow(GoogleError)
    script.pullError = new GoogleError("search.foreign_site", 403)
    await expect(drive()).rejects.toThrow(NonRetryableError)
  })
})
