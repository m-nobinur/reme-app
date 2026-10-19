import { describe, expect, it, vi } from "vitest"

// The lead's whole tool list, built the way the agent builds it at start. A
// tool definition or schema that throws ends the build before the first model
// call (measured 2026-10-16: write_pages with an empty input), so it has to
// fail here and not at the first owner's claim.
const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }))
vi.mock("cloudflare:workers", () => ({
  env: {
    OPENROUTER_API_KEY: "stub",
    ASSIGNMENTS: {
      get: async () => ({
        sendEvent: async (event: unknown) => {
          sent.push(event)
        },
      }),
    },
  },
}))
vi.mock("@workspace/facade/cloudflare", () => ({
  cloudflareSandbox: () => ({}),
}))
vi.mock("../src/sandbox.ts", () => ({
  checkpoint: async () => undefined,
  recover: async () => undefined,
}))

const { Developer, developerTools, sandboxTools, unlisted } = await import(
  "../src/agents/developer.ts"
)

const current = {
  runtime: { spec: { org_id: "o", staff_id: "s" } },
  brief: { snapshot: { assignment_id: "a" } },
  tee: { emit: () => undefined, flush: async () => undefined },
  mutations: async (_key: string, run: () => Promise<unknown>) => run(),
  gate: { fromChild: () => false },
}

describe("the Developer's tool list", () => {
  it("builds write_pages, ask_chief and report_complete", () => {
    const tools = developerTools(current as never) as unknown as {
      name: string
    }[]
    expect(tools.map((tool) => tool.name)).toEqual([
      "write_pages",
      "ask_chief",
      "report_complete",
    ])
  })

  it("builds the guarded sandbox tools, checkpoint among them", () => {
    const sandbox = { resolvePath: (path: string) => path }
    const tools = sandboxTools(current as never)(
      sandbox as never,
      {} as never
    ) as {
      name: string
    }[]
    expect(tools.map((tool) => tool.name)).toContain("checkpoint")
    expect(tools).toHaveLength(7)
  })
})

describe("a Developer that cannot start", () => {
  it("tells the Workflow, which fails the build, and still throws", async () => {
    // No runtime around it, so rendering throws before any tool is built.
    expect(() => Developer({ id: "a" } as never)).toThrow()
    await vi.waitFor(() =>
      expect(sent).toEqual([
        {
          type: "developer",
          payload: { kind: "start_failed", reason: expect.any(String) },
        },
      ])
    )
  })
})

// Perf run 2: the harness's listing of the site grew between deliveries and
// rewrote the lead's whole cached prompt after the critique.
describe("the lead's sandbox, as the harness lists it", () => {
  it("lists the site as empty whatever is built, and every other directory as it is", async () => {
    let built = ["src", "package.json"]
    const create = unlisted(async (_: { id: string }) => ({
      cwd: "/workspace",
      readdir: async (path: string) => (path === "/tmp" ? ["x"] : built),
    }))
    const sandbox = await create({ id: "a" })
    expect(await sandbox.readdir("/workspace/site")).toEqual([])
    built = [...built, "dist", ".astro"]
    expect(await sandbox.readdir("/workspace/site/")).toEqual([])
    expect(await sandbox.readdir("/workspace/site/src")).toEqual(built)
    expect(await sandbox.readdir("/tmp")).toEqual(["x"])
    expect(sandbox.cwd).toBe("/workspace")
  })
})
