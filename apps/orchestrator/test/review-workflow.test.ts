import { beforeEach, describe, expect, it, vi } from "vitest"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * Both paths through `ReviewWorkflow`, driven with a recording step and its
 * bodies stood in for, so the step names are the committed list in
 * workflow-steps.json. The bodies are tested in consult.test.ts.
 */

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown
    constructor(_ctx: unknown, env: unknown) {
      this.env = env
    }
  },
}))

const script = vi.hoisted(() => ({ fails: false, calls: [] as string[] }))
vi.mock("../src/consult.ts", () => ({
  runReview: async () => {
    if (script.fails) throw new Error("review.gone")
    return { review: {} }
  },
  tellReview: async () => {
    script.calls.push("told report")
  },
  tellFailed: async () => {
    script.calls.push("told failure")
  },
}))
vi.mock("../src/domain-flow.ts", () => ({
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
}))
vi.mock("../src/domain-workflow.ts", () => ({ SAY_RETRIES: {} }))
vi.mock("../src/schedule.ts", () => ({ passWake: async () => undefined }))

const { ReviewWorkflow } = await import("../src/review-workflow.ts")

async function drive() {
  const names: string[] = []
  const step = {
    do: async (name: string, _config: unknown, fn: () => Promise<unknown>) => {
      names.push(name)
      return fn()
    },
  }
  const result = await new ReviewWorkflow({} as never, {} as never).run(
    { payload: { org_id: "org", revision_id: "rev" } } as never,
    step as never
  )
  return { names, result }
}

beforeEach(() => {
  script.fails = false
  script.calls.length = 0
})

describe("the review Workflow", () => {
  it("reviews, then tells the assistant the report", async () => {
    const { names, result } = await drive()
    expect(names).toEqual(steps.ReviewWorkflow.reviewed)
    expect(script.calls).toEqual(["told report"])
    expect(result).toEqual({ outcome: "reviewed" })
  })

  it("tells the assistant when the review could not finish", async () => {
    script.fails = true
    const { names, result } = await drive()
    expect(names).toEqual(steps.ReviewWorkflow.failed)
    expect(script.calls).toEqual(["told failure"])
    expect(result).toEqual({ outcome: "failed" })
  })
})
