import { beforeEach, describe, expect, it, vi } from "vitest"

// The real `report_complete` tool, with the Worker, the container and the
// build tail stood in for: the guard has to hold inside `run`, before the
// tail touches the disk.
const { sent, finished } = vi.hoisted(() => ({
  sent: [] as unknown[],
  finished: [] as unknown[],
}))
vi.mock("cloudflare:workers", () => ({
  env: {
    // Read at module load to pick a transport; no model is called here.
    OPENROUTER_API_KEY: "stub",
    SITE_HOST_SUFFIX: "-stg.remeai.co.uk",
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
vi.mock("../src/tail.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tail.ts")>()),
  finishRevision: async (input: unknown) => {
    finished.push(input)
    const ran = { exit_code: 0, output: "", ms: 1 }
    return {
      revisionId: "20000000-0000-4000-8000-000000000001",
      check: ran,
      build: ran,
      manifest: { files: 3, reused: 0, bytes: 10, ms: 1 },
      custom: { exit_code: 0, key: null, ms: 1 },
      source: { key: "k", ms: 1 },
    }
  },
}))

const { reportComplete } = await import("../src/agents/developer.ts")

const ORG = "10000001-0000-4000-8000-000000000000"
let state = "implementing"
const emitted: string[] = []
const current = {
  runtime: {
    spec: {
      org_id: ORG,
      staff_id: ORG.replace(/0$/, "2"),
      session_id: ORG.replace(/0$/, "3"),
    },
  },
  brief: { snapshot: { assignment_id: ORG.replace(/0$/, "9"), facts: [] } },
  kit: {
    withOrg: async (_: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({ from: () => ({ where: async () => [{ state }] }) }),
      }),
  },
  tee: {
    emit: (type: string) => emitted.push(type),
    flush: async () => undefined,
  },
}
type Run = (args: unknown) => Promise<{ output: string; terminate: boolean }>
const run = (reportComplete(current as never) as unknown as { run: Run }).run
const call = (left_out?: unknown[]) =>
  run({
    data: {
      summary: "Built",
      changes: [{ path: "src/site-config.ts", reason: "Filled from facts" }],
      risks: [],
      decisions_needed: [],
      left_out,
    },
    harness: { sandbox: {} },
    step: { do: (_: string, fn: () => Promise<unknown>) => fn() },
  })

describe("report_complete", () => {
  beforeEach(() => {
    sent.length = 0
    finished.length = 0
    emitted.length = 0
  })

  it("builds, reports and wakes the Workflow while the build is implementing", async () => {
    state = "implementing"
    const result = await call()
    expect(finished).toHaveLength(1)
    expect(emitted).toEqual(["assignment.completion_reported"])
    expect(sent).toHaveLength(1)
    expect(result.terminate).toBe(true)
  })

  it("refuses a left-out item the owner could not be asked, before it builds", async () => {
    state = "implementing"
    await expect(
      call([
        {
          field: "business.insurance",
          question: "What should business.insurance say?",
          answer_schema: { type: "string" },
          options: null,
        },
      ])
    ).rejects.toThrow(/left_out business.insurance/)
    expect(finished).toEqual([])
    expect(emitted).toEqual([])
  })

  // Row 8 of the measured build: a lead resumed after an interruption
  // reported again once the Workflow had taken its first report to the
  // preview, rebuilding the disk under the preview's own steps.
  it.each(["validating", "preview_ready", "cancelled"])(
    "touches nothing once the build is %s",
    async (now) => {
      state = now
      const result = await call()
      expect(finished).toEqual([])
      expect(emitted).toEqual([])
      expect(sent).toEqual([])
      expect(result).toMatchObject({ terminate: true })
      expect(result.output).toContain(now)
    }
  )
})
