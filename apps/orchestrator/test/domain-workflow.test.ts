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
  /** Whether every post finds the chat busy, as a never-answered card would. */
  busy: false,
  /** Whether every wait is ended by a `check` nudge. */
  nudged: false,
}))
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
  claimHostnames: async () => script.claim,
  look: async () => script.seen.shift() ?? { gone: true },
  nudge: async () => {
    script.calls.push("nudge")
    return { key: "nudge", text: "nudge" }
  },
  expireDomain: async (...args: unknown[]) => {
    script.calls.push(`expire ${String(args[4])}`)
    return { key: `failed ${String(args[4])}`, text: "failed" }
  },
  activateDomain: async () => {
    script.calls.push("activate")
    return { key: "live", text: "live" }
  },
  repoint: async () => {
    script.calls.push("repoint")
  },
  postStatus: async (_kit: unknown, _org: unknown, say: { key: string }) => {
    if (script.busy) throw new Error("status.busy")
    script.calls.push(`say ${say.key}`)
  },
}))

const { nextWait } = await import("../src/domain-flow.ts")
const { DomainWorkflow, MAX_CHECKS, SAY_RETRIES } = await import(
  "../src/domain-workflow.ts"
)

const T0 = Date.parse("2026-10-16T12:00:00Z")
const MIN = 60 * 1000
const HOUR = 60 * MIN
const at = (
  ms: number,
  status = "pending_verification",
  ready = false,
  say?: string
): Seen =>
  ({
    gone: false,
    at: T0 + ms,
    status,
    ready,
    ...(say && { say: { key: say, text: say } }),
  }) as Seen

async function drive(
  seen: Seen[],
  claim: unknown = { apex: "a", www: "w" },
  extra: { settle?: true } = {}
) {
  script.claim = claim
  script.seen = [...seen]
  const names: string[] = []
  const waits: (number | string)[] = []
  const configs: Record<string, unknown> = {}
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name)
      if (typeof a !== "function") configs[name] = a
      return ((typeof a === "function" ? a : b) as () => Promise<unknown>)()
    },
    sleep: async (name: string, duration: string) => {
      names.push(name)
      waits.push(duration)
    },
    waitForEvent: async (name: string, options: { timeout: number }) => {
      names.push(name)
      waits.push(options.timeout)
      if (script.nudged) return { type: "check", payload: {} }
      throw new Error("timed out")
    },
  }
  const result = await new DomainWorkflow({} as never, {} as never).run(
    {
      payload: { org_id: "org", domain_id: "dom", ...extra },
      timestamp: new Date(T0),
    } as never,
    step as never
  )
  return { names, waits, result, configs }
}

beforeEach(() => {
  script.calls.length = 0
  script.busy = false
  script.nudged = false
})

describe("the domain Workflow", () => {
  it("looks on the backoff, says what changed, activates once ready, and points again after it settles", async () => {
    const { names, waits, result, configs } = await drive([
      at(1000),
      at(2 * MIN, "conflicting_record", false, "look 2"),
      at(7 * MIN, "valid", true),
    ])
    expect(names).toEqual(steps.DomainWorkflow.live)
    expect(waits).toEqual([MIN, MIN, "30 seconds"])
    expect(result).toEqual({ outcome: "active" })
    expect(script.calls).toEqual([
      "say look 2",
      "activate",
      "say live",
      "repoint",
    ])
    // Each post retries on its own schedule; nothing else does.
    expect(configs).toEqual({ "say 2": SAY_RETRIES, "say live": SAY_RETRIES })
  })

  it("goes live even when the chat stays busy past every retry", async () => {
    script.busy = true
    const { names, result } = await drive([at(MIN, "valid", true, "look 1")])
    expect(result).toEqual({ outcome: "active" })
    expect(names).toContain("say live")
    expect(script.calls).toEqual(["activate", "repoint"])
  })

  it("backs off a busy chat from 10 seconds, doubling, capped at 30 minutes", () => {
    const delay = SAY_RETRIES.retries?.delay as (input: {
      ctx: { attempt: number }
    }) => number
    expect(
      [1, 2, 3, 8, 9, 200].map((attempt) => delay({ ctx: { attempt } }))
    ).toEqual([10_000, 20_000, 40_000, 1_280_000, 30 * MIN, 30 * MIN])
  })

  it("a removal's instance only points again after it settles", async () => {
    const { names, waits, result } = await drive([], undefined, {
      settle: true,
    })
    expect(names).toEqual(steps.DomainWorkflow["removal settles"])
    expect(waits).toEqual(["30 seconds"])
    expect(result).toEqual({ outcome: "removed" })
    expect(script.calls).toEqual(["repoint"])
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
    expect(waits).toEqual([MIN, HOUR, 30 * 1000])
    expect(result).toEqual({ outcome: "failed" })
    expect(script.calls).toEqual([
      "nudge",
      "say nudge",
      "expire timeout",
      "say failed timeout",
    ])
  })

  it("nudges only once however many looks pass 24 hours", async () => {
    await drive([at(25 * HOUR), at(26 * HOUR), at(27 * HOUR)])
    expect(script.calls.filter((c) => c === "nudge")).toHaveLength(1)
  })

  it("waits by how long the claim has been connecting, not by how many looks", async () => {
    const { waits } = await drive(
      [0, 29, 30, 119, 120, 71 * 60].map((m) => at(m * MIN))
    )
    expect(waits).toEqual([1, 1, 10, 10, 60, 60].map((m) => m * MIN))
  })

  it("spends well under a Free plan's 1,024 steps over 72 hours, nudged or not", async () => {
    // Every look on schedule, from the first at the start to the deadline.
    const schedule: Seen[] = []
    for (let t = 0; t <= 72 * HOUR; t += nextWait(t)) schedule.push(at(t))
    const quiet = await drive(schedule)
    expect(quiet.result).toEqual({ outcome: "failed" })
    expect(schedule.length).toBeLessThan(120)
    expect(quiet.names.length).toBeLessThan(250)

    // A chat that nudges every wait: past MAX_CHECKS the waits are sleeps,
    // which are not steps, on the same schedule.
    script.nudged = true
    const looks = MAX_CHECKS + 5
    const nudged = await drive(
      Array.from({ length: looks }, (_, i) => at(i * 1000))
    )
    expect(nudged.names.filter((n) => n.startsWith("check "))).toHaveLength(
      MAX_CHECKS
    )
    expect(nudged.names.filter((n) => n.startsWith("wait "))).toHaveLength(5)
    expect(nudged.waits.slice(MAX_CHECKS)).toEqual(Array(5).fill(MIN))
  })

  it("fails a claim whose hostname is held elsewhere, without looking", async () => {
    const { names, result } = await drive([], "held")
    expect(names).toEqual(steps.DomainWorkflow["hostname held"])
    expect(result).toEqual({ outcome: "failed" })
    expect(script.calls).toEqual(["expire held", "say failed held"])
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
