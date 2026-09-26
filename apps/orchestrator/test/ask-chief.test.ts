import { beforeEach, describe, expect, it, vi } from "vitest"

// The real `ask_chief` tool, with only the Worker and the container stood in
// for: the refusal has to hold inside `run`, not just in `question.ts`.
const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }))
vi.mock("cloudflare:workers", () => ({
  env: {
    // Read at module load to pick a transport; no model is called here.
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
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  OperationInterruptedError: class extends Error {},
}))
vi.mock("@workspace/facade/cloudflare", () => ({
  cloudflareSandbox: () => ({}),
}))
vi.mock("../src/sandbox.ts", () => ({
  checkpoint: async () => undefined,
  recover: async () => undefined,
}))

const { askChief } = await import("../src/agents/developer.ts")

const ORG = "10000001-0000-4000-8000-000000000000"
const emitted: unknown[] = []
const current = {
  runtime: { spec: { org_id: ORG, staff_id: ORG.replace(/0$/, "2") } },
  brief: { snapshot: { assignment_id: ORG.replace(/0$/, "9") } },
  tee: {
    emit: (type: string, payload: unknown) => emitted.push({ type, payload }),
    flush: async () => undefined,
  },
}
type Run = (args: { data: unknown }) => Promise<unknown>
const run = (askChief(current as never) as unknown as { run: Run }).run

describe("ask_chief", () => {
  beforeEach(() => {
    emitted.length = 0
    sent.length = 0
  })

  it("refuses the question a staging run asked, before it logs or wakes anything", async () => {
    await expect(
      run({
        data: {
          field: "hours.saturday",
          why: "The hours section shows Saturday.",
          answer_schema: {
            type: "object",
            required: ["open", "close"],
            properties: { open: { type: "string" }, close: { type: "string" } },
          },
          options: ["null"],
          blocking: true,
        },
      })
    ).rejects.toThrow(/option/)
    expect(emitted).toEqual([])
    expect(sent).toEqual([])
  })

  it("asks a text question with literal options, logging it and waking the build", async () => {
    await expect(
      run({
        data: {
          field: "hours.saturday",
          why: "The hours section shows Saturday.",
          answer_schema: { type: "string", maxLength: 40 },
          options: ["Closed", "09:00 to 13:00"],
          blocking: true,
        },
      })
    ).resolves.toMatchObject({ terminate: true })
    expect(emitted).toMatchObject([
      {
        type: "information.requested",
        payload: { options: ["Closed", "09:00 to 13:00"] },
      },
    ])
    expect(sent).toHaveLength(1)
  })
})
