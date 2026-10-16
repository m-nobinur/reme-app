import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Seen } from "../src/domain-flow.ts"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * Every path through `DomainWorkflow`, driven with a recording step and its
 * step bodies scripted, so the step names are the committed list in
 * workflow-steps.json and the waits follow the backoff and the 72-hour
 * deadline. The bodies themselves are tested in domain-flow.test.ts.
 */

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown
    constructor(_ctx: unknown, env: unknown) {
      this.env = env
    }
  },
}))

const script = vi.hoisted(() => ({
  claim: { apex: "a", www: "w" } as unknown,
  seen: [] as unknown[],
  calls: [] as string[],
}))
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
  claimHostnames: async () => script.claim,
  look: async () => script.seen.shift() ?? { gone: true },
  nudge: async () => {
    script.calls.push("nudge")
  },
  expireDomain: async (...args: unknown[]) => {
    script.calls.push(`expire ${String(args[4])}`)
  },
  activateDomain: async () => {
    script.calls.push("activate")
    return true
  },
}))

const { DomainWorkflow } = await import("../src/domain-workflow.ts")

const T0 = Date.parse("2026-10-16T12:00:00Z")
const MIN = 60 * 1000
const HOUR = 60 * MIN
const at = (ms: number, status = "pending_verification", ready = false): Seen =>
  ({ gone: false, at: T0 + ms, status, ready }) as Seen

async function drive(seen: Seen[], claim: unknown = { apex: "a", www: "w" }) {
  script.claim = claim
  script.seen = [...seen]
  const names: string[] = []
  const waits: number[] = []
  const step = {
    do: async (name: string, fn: () => Promise<unknown>) => {
      names.push(name)
      return fn()
    },
    waitForEvent: async (name: string, options: { timeout: number }) => {
      names.push(name)
      waits.push(options.timeout)
      throw new Error("timed out")
    },
  }
  const result = await new DomainWorkflow({} as never, {} as never).run(
    {
      payload: { org_id: "org", domain_id: "dom" },
      timestamp: new Date(T0),
    } as never,
    step as never
  )
  return { names, waits, result }
}

beforeEach(() => {
  script.calls.length = 0
})

describe("the domain Workflow", () => {
  it("looks on the backoff and activates once a look is ready", async () => {
    const { names, waits, result } = await drive([
      at(1000),
      at(2 * MIN, "conflicting_record"),
      at(7 * MIN, "valid", true),
    ])
    expect(names).toEqual(steps.DomainWorkflow.live)
    expect(waits).toEqual([2 * MIN, 5 * MIN])
    expect(result).toEqual({ outcome: "active" })
    expect(script.calls).toEqual(["activate"])
  })

  it("nudges once after 24 hours and fails at 72, leaving activation untouched", async () => {
    const { names, waits, result } = await drive([
      at(MIN),
      at(25 * HOUR),
      at(72 * HOUR - 30 * 1000),
      at(72 * HOUR),
    ])
    expect(names).toEqual(steps.DomainWorkflow["nudged then expired"])
    // The last wait before the deadline is cut to what is left of it.
    expect(waits).toEqual([2 * MIN, 5 * MIN, 30 * 1000])
    expect(result).toEqual({ outcome: "failed" })
    expect(script.calls).toEqual(["nudge", "expire timeout"])
  })

  it("nudges only once however many looks pass 24 hours", async () => {
    await drive([at(25 * HOUR), at(26 * HOUR), at(27 * HOUR)])
    expect(script.calls.filter((c) => c === "nudge")).toHaveLength(1)
  })

  it("waits an hour per look after the first four", async () => {
    const { waits } = await drive([1, 2, 3, 4, 5, 6].map((n) => at(n * MIN)))
    expect(waits).toEqual([2, 5, 15, 30, 60, 60].map((m) => m * MIN))
  })

  it("fails a claim whose hostname is held elsewhere, without looking", async () => {
    const { names, result } = await drive([], "held")
    expect(names).toEqual(steps.DomainWorkflow["hostname held"])
    expect(result).toEqual({ outcome: "failed" })
    expect(script.calls).toEqual(["expire held"])
  })

  it("ends quietly for a claim removed before or while it waits", async () => {
    const before = await drive([], "gone")
    expect(before.names).toEqual(
      steps.DomainWorkflow["removed before the hostnames"]
    )
    expect(before.result).toEqual({ outcome: "removed" })
    const during = await drive([at(MIN), { gone: true }])
    expect(during.names).toEqual(steps.DomainWorkflow["removed while waiting"])
    expect(during.result).toEqual({ outcome: "removed" })
    expect(script.calls).toEqual([])
  })
})
