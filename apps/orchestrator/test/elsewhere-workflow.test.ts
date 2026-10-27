import { beforeEach, describe, expect, it, vi } from "vitest"
import steps from "./workflow-steps.json" with { type: "json" }

/**
 * Every path through `ElsewhereWorkflow`, driven with a recording step and
 * its bodies scripted, so the step names are the committed list in
 * workflow-steps.json. The bodies are tested in domain-buy.test.ts.
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
  seen: [] as unknown[],
  calls: [] as string[],
  /** Whether the owner's done ends each wait. */
  woken: false,
}))
vi.mock("../src/domain-buy.ts", () => ({
  lookElsewhere: async () => ({ result: script.seen.shift() }),
  followUpElsewhere: async () => {
    script.calls.push("follow up")
    return { key: "follow up", text: "follow up" }
  },
}))
vi.mock("../src/domain-flow.ts", () => ({
  withKit: async (_env: unknown, fn: (kit: unknown) => unknown) => fn({}),
  postStatus: async (_kit: unknown, _org: unknown, say: { key: string }) => {
    script.calls.push(`say ${say.key}`)
  },
}))
vi.mock("../src/domain-workflow.ts", () => ({ SAY_RETRIES: {} }))

const { ElsewhereWorkflow, FOLLOW_UP_MS, GIVE_UP_MS } = await import(
  "../src/elsewhere-workflow.ts"
)

const T0 = Date.parse("2026-10-27T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const look = (ms: number, extra: object = {}) => ({
  registered: false,
  claimed: false,
  at: T0 + ms,
  ...extra,
})

async function drive(seen: unknown[]) {
  script.seen = [...seen]
  const names: string[] = []
  const waits: unknown[] = []
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name)
      return ((typeof a === "function" ? a : b) as () => Promise<unknown>)()
    },
    waitForEvent: async (
      name: string,
      options: { type: string; timeout: number }
    ) => {
      names.push(name)
      waits.push([options.type, options.timeout])
      if (script.woken) return { type: options.type, payload: {} }
      throw new Error("timed out")
    },
  }
  const result = await new ElsewhereWorkflow({} as never, {} as never).run(
    {
      payload: { org_id: "org", name: "bright.com" },
      timestamp: new Date(T0),
    } as never,
    step as never
  )
  return { names, waits, result }
}

beforeEach(() => {
  script.calls.length = 0
  script.woken = false
})

describe("the buy-it-elsewhere Workflow", () => {
  it("looks daily and ends with the offer once the registry shows the name", async () => {
    const { names, waits, result } = await drive([
      look(0),
      look(DAY, {
        registered: true,
        say: { key: "offer", text: "offer" },
      }),
    ])
    expect(names).toEqual(steps.ElsewhereWorkflow.registered)
    expect(waits).toEqual([["owner_done", DAY]])
    expect(result).toEqual({ outcome: "bought" })
    expect(script.calls).toEqual(["say offer"])
  })

  it("ends quietly when the owner's done finds a claim", async () => {
    script.woken = true
    const { names, result } = await drive([
      look(0),
      look(60_000, { claimed: true }),
    ])
    expect(names).toEqual(steps.ElsewhereWorkflow["owner done"])
    expect(result).toEqual({ outcome: "bought" })
    expect(script.calls).toEqual([])
  })

  it("follows up once after three days and stops after a month", async () => {
    const { names, result } = await drive([
      look(0),
      look(FOLLOW_UP_MS),
      look(FOLLOW_UP_MS + DAY),
      look(GIVE_UP_MS),
    ])
    expect(names).toEqual(steps.ElsewhereWorkflow["follow up and stop"])
    expect(result).toEqual({ outcome: "stopped" })
    expect(script.calls).toEqual(["follow up", "say follow up"])
  })
})
