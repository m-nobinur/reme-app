import { beforeEach, describe, expect, it, vi } from "vitest"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * `SearchWorkflow`'s paths, driven with a recording step and its bodies
 * scripted, so the step names are the committed list in workflow-steps.json.
 * The bodies themselves are tested in search.test.ts.
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
  verifies: [] as boolean[],
  calls: [] as string[],
  tokenError: null as Error | null,
}))
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
}))
// The engine is tested against a database in probe.test.ts; here it is the step it runs in.
vi.mock("../src/probe.ts", () => ({
  probe: (
    step: { do: (...args: unknown[]) => unknown },
    name: string,
    _env: unknown,
    _target: unknown,
    read: (kit: unknown) => Promise<{ result: unknown }>,
    config: unknown
  ) => step.do(name, config, () => read({}).then((seen) => seen.result)),
}))
vi.mock("../src/search.ts", () => ({
  fileToken: async () => {
    if (script.tokenError) throw script.tokenError
    return "google1a2b.html"
  },
  placeToken: async (...args: unknown[]) => {
    script.calls.push(`place ${String(args[3])}`)
  },
  verifyOnce: async () => script.verifies.shift() ?? false,
  addProperty: async (...args: unknown[]) => {
    script.calls.push(args[3] ? "sitemap" : "add")
  },
  markVerified: async () => {
    script.calls.push("verified")
  },
  markFailed: async () => {
    script.calls.push("failed")
  },
  announce: async () => {
    script.calls.push("announce")
  },
  sayVerifyFailed: async () => {
    script.calls.push("say failed")
  },
}))

const { GoogleError } = await import("../src/google.ts")
const { NonRetryableError } = await import("cloudflare:workflows")
const { SearchWorkflow, GOOGLE_RETRIES } = await import(
  "../src/search-workflow.ts"
)

async function drive() {
  const names: string[] = []
  const waits: unknown[] = []
  const configs: Record<string, unknown> = {}
  const step = {
    do: async (name: string, config: unknown, fn: () => Promise<unknown>) => {
      names.push(name)
      configs[name] = config
      return fn()
    },
    sleep: async (name: string, duration: unknown) => {
      names.push(name)
      waits.push(duration)
    },
  }
  const result = await new SearchWorkflow({} as never, {} as never).run(
    { payload: { org_id: "org", host: "a-stg.remeai.co.uk" } } as never,
    step as never
  )
  return { names, waits, result, configs }
}

beforeEach(() => {
  script.verifies = []
  script.calls.length = 0
  script.tokenError = null
})

describe("the search Workflow", () => {
  it("places the file, verifies, adds the property, submits the sitemap and says so once", async () => {
    script.verifies = [false, true]
    const { names, waits, result, configs } = await drive()
    expect(names).toEqual(steps.SearchWorkflow.verified)
    expect(waits).toEqual(["60 seconds", "30 seconds"])
    expect(result).toEqual({ outcome: "verified" })
    expect(script.calls).toEqual([
      "place google1a2b.html",
      "add",
      "sitemap",
      "verified",
      "announce",
    ])
    expect(configs.token).toBe(GOOGLE_RETRIES)
  })

  it("tries three times 30 s apart, then backs off to 72 hours, then fails and says so once", async () => {
    const { names, waits, result } = await drive()
    expect(names).toEqual(steps.SearchWorkflow["never verified"])
    expect(waits).toEqual([
      "60 seconds",
      "30 seconds",
      "30 seconds",
      "10 minutes",
      "1 hour",
      "6 hours",
      "24 hours",
      "72 hours",
    ])
    expect(result).toEqual({ outcome: "failed" })
    expect(script.calls).toEqual([
      "place google1a2b.html",
      "failed",
      "say failed",
    ])
  })

  it("retries only Google's outage: any other Google answer is final", async () => {
    script.tokenError = new GoogleError("google.unavailable", 503)
    await expect(drive()).rejects.toThrow(GoogleError)
    script.tokenError = new GoogleError("google.403", 403)
    await expect(drive()).rejects.toThrow(NonRetryableError)
    await expect(drive()).rejects.toThrow("google.403")
  })
})
