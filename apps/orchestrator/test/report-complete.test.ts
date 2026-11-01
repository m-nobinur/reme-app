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
      text: {
        text_changes: [{ before: "Old", after: "New", pages: ["/"] }],
        text_changes_left: 1,
      },
    }
  },
}))

const { reportComplete, reportNudge } = await import(
  "../src/agents/developer.ts"
)

const ORG = "10000001-0000-4000-8000-000000000000"
let state = "implementing"
const emitted: string[] = []
const reports: Record<string, unknown>[] = []
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
    emit: (type: string, payload: Record<string, unknown>) => {
      emitted.push(type)
      reports.push(payload)
    },
    flush: async () => undefined,
  },
}
type Run = (args: unknown) => Promise<{ output: string; terminate: boolean }>
const run = (reportComplete(current as never) as unknown as { run: Run }).run
const call = (left_out?: unknown[], notes?: unknown[]) =>
  run({
    data: {
      summary: "Built",
      changes: [{ path: "src/site-config.ts", reason: "Filled from facts" }],
      risks: [],
      decisions_needed: [],
      left_out,
      notes,
    },
    harness: { sandbox: {} },
    step: { do: (_: string, fn: () => Promise<unknown>) => fn() },
  })

describe("report_complete", () => {
  beforeEach(() => {
    sent.length = 0
    finished.length = 0
    emitted.length = 0
    reports.length = 0
  })

  it("builds, reports and wakes the Workflow while the build is implementing", async () => {
    state = "implementing"
    const result = await call()
    expect(finished).toHaveLength(1)
    expect(emitted).toEqual(["assignment.completion_reported"])
    expect(reports[0]).toMatchObject({
      text_changes: [{ before: "Old", after: "New", pages: ["/"] }],
      text_changes_left: 1,
    })
    expect(sent).toHaveLength(1)
    expect(result.terminate).toBe(true)
  })

  it("carries the notes into the stored report", async () => {
    state = "implementing"
    const notes = [{ about: "no prices", why: "No fact gives a price." }]
    await call(undefined, notes)
    expect(reports[0]?.notes).toEqual(notes)
  })

  it("stores a report without notes as before", async () => {
    state = "implementing"
    await call()
    expect(reports[0]).not.toHaveProperty("notes")
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
    ).rejects.toThrow(
      /^Not reported yet: report_complete refused left_out business.insurance\..*call report_complete again/
    )
    expect(finished).toEqual([])
    expect(emitted).toEqual([])
  })

  // #527, the recorded legal-04 report: the owner's own pick in left_out was
  // refused, the lead wrote "reported complete" in prose and the build failed.
  it("drops an owner's own pick from left_out and reports the rest", async () => {
    state = "implementing"
    const question = (field: string, text: string) => ({
      field,
      options: null,
      question: text,
      answer_schema: { type: "string", maxLength: 500 },
    })
    await call([
      question(
        "overview",
        "How would you describe how the practice works with clients, day to day?"
      ),
      question(
        "audience",
        "Who does the practice mainly act for: employees, employers, or both?"
      ),
      question(
        "proof",
        "What record can the practice state, such as years trading, a regulator or memberships?"
      ),
      {
        field: "testimonials.review_1",
        options: null,
        question:
          "Do you have a client's review they have agreed can be quoted on the site?",
        answer_schema: { type: "object" },
      },
    ])
    expect(finished).toHaveLength(1)
    expect(reports[0]?.left_out).toEqual([
      expect.objectContaining({ field: "overview" }),
      expect.objectContaining({ field: "audience" }),
      expect.objectContaining({ field: "proof" }),
    ])
    expect(sent).toHaveLength(1)
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

describe("a response that ends after a refused report", () => {
  // The recorded legal-04 response: one refused report_complete, then prose.
  it("sends the lead back to report", () => {
    expect(
      reportNudge([
        { tool: "write", isError: false },
        { tool: "report_complete", isError: true },
      ])
    ).toMatchObject({
      kind: "signal",
      type: "report.refused",
      body: expect.stringMatching(/call report_complete again/),
    })
  })

  it("sends nothing once a report or a question was accepted, or with no report tried", () => {
    expect(
      reportNudge([
        { tool: "report_complete", isError: true },
        { tool: "report_complete", isError: false },
      ])
    ).toBeNull()
    expect(
      reportNudge([
        { tool: "report_complete", isError: true },
        { tool: "ask_chief", isError: false },
      ])
    ).toBeNull()
    expect(reportNudge([{ tool: "write", isError: false }])).toBeNull()
  })
})
