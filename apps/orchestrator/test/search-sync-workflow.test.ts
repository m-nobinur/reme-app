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
}))
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
}))
vi.mock("../src/search-sync.ts", () => ({
  syncTargets: async () => [
    "https://a.example.test/",
    "https://b.example.test/",
  ],
  pullProperty: async (...args: unknown[]) => {
    if (script.pullError) throw script.pullError
    script.calls.push(`pull ${String(args[3])}`)
    return { days: 30, pairs: 4 }
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

  it("stops at a revoked token without failing", async () => {
    script.pullError = new NeedsReauth()
    const { names, result } = await drive()
    expect(names).toEqual(steps.SearchSyncWorkflow["needs reauth"])
    expect(result).toEqual({ outcome: "needs_reauth" })
  })

  it("retries only Google's outage", async () => {
    script.pullError = new GoogleError("google.unavailable", 503)
    await expect(drive()).rejects.toThrow(GoogleError)
    script.pullError = new GoogleError("search.foreign_site", 403)
    await expect(drive()).rejects.toThrow(NonRetryableError)
  })
})
