import type { FlueObservation } from "@flue/runtime"
import { describe, expect, it } from "vitest"
import { type BudgetEvent, createBudgetGuard } from "../src/budget.ts"

/** A `turn` observation carrying one cost, the leaf level the guard sums. */
const turn = (total: number) =>
  ({
    v: 3,
    eventIndex: 0,
    timestamp: "2026-09-15T00:00:00.000Z",
    type: "turn",
    turnId: "t",
    purpose: "agent",
    durationMs: 1,
    request: {
      providerId: "openrouter",
      providerName: "openrouter",
      requestedModel: "deepseek/deepseek-v4.1-flash",
      api: "openai-completions",
    },
    response: {
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      },
    },
    isError: false,
  }) as unknown as FlueObservation

const modelCall = { type: "model", turnId: "t" } as const

describe("the pre-call budget guard", () => {
  it("refuses the second model call on a $0.01 cap once the first turn spent it", async () => {
    const events: BudgetEvent[] = []
    const guard = createBudgetGuard({
      capUsd: 0.01,
      onEvent: (e) => events.push(e),
    })
    const { interceptor, observe } = guard.instrumentation
    let calls = 0
    const next = async () => {
      calls += 1
      return "ok"
    }
    // First call: nothing spent, allowed.
    await expect(interceptor(modelCall, {}, next)).resolves.toBe("ok")
    await observe(turn(0.012), {} as never)
    // Second call: over the cap, refused before `next` runs.
    await expect(interceptor(modelCall, {}, next)).rejects.toMatchObject({
      code: "budget.exhausted",
      errorClass: "resource",
    })
    expect(calls).toBe(1)
    expect(events.map((e) => e.type)).toEqual(["budget.exhausted"])
    expect(guard.spent()).toBeCloseTo(0.012)
  })

  it("warns once at 80% and keeps going", async () => {
    const events: BudgetEvent[] = []
    const { interceptor, observe } = createBudgetGuard({
      capUsd: 1,
      spentUsd: 0.5,
      onEvent: (e) => events.push(e),
    }).instrumentation
    const next = async () => "ok"
    await interceptor(modelCall, {}, next)
    await observe(turn(0.35), {} as never)
    await interceptor(modelCall, {}, next)
    await interceptor(modelCall, {}, next)
    expect(events.map((e) => e.type)).toEqual(["budget.warning"])
    expect(events[0]?.payload.ratio).toBeCloseTo(0.85)
  })

  it("counts what the log says was spent before it, read once", async () => {
    const events: BudgetEvent[] = []
    let reads = 0
    const guard = createBudgetGuard({
      capUsd: 0.01,
      spentBefore: async () => {
        reads += 1
        return 0.004
      },
      onEvent: (e) => events.push(e),
    })
    const { interceptor, observe } = guard.instrumentation
    let calls = 0
    const next = async () => {
      calls += 1
      return "ok"
    }
    await expect(interceptor(modelCall, {}, next)).resolves.toBe("ok")
    // A spend the fresh guard alone would allow, and the assignment would not.
    await observe(turn(0.007), {} as never)
    await expect(interceptor(modelCall, {}, next)).rejects.toMatchObject({
      code: "budget.exhausted",
    })
    expect(calls).toBe(1)
    expect(reads).toBe(1)
    expect(guard.spent()).toBeCloseTo(0.011)
  })

  it("refuses the call when the log cannot be read, and reads again next time", async () => {
    let reads = 0
    const { interceptor } = createBudgetGuard({
      capUsd: 1,
      spentBefore: async () => {
        reads += 1
        if (reads === 1) throw new Error("database unavailable")
        return 0
      },
      onEvent: () => undefined,
    }).instrumentation
    let calls = 0
    const next = async () => {
      calls += 1
      return "ok"
    }
    await expect(interceptor(modelCall, {}, next)).rejects.toThrow(
      "database unavailable"
    )
    expect(calls).toBe(0)
    await expect(interceptor(modelCall, {}, next)).resolves.toBe("ok")
    expect(reads).toBe(2)
  })

  it("leaves tool and agent operations alone", async () => {
    const { interceptor } = createBudgetGuard({
      capUsd: 0,
      onEvent: () => undefined,
    }).instrumentation
    await expect(
      interceptor(
        { type: "tool", toolCallId: "c", toolName: "bash" },
        {},
        async () => "ran"
      )
    ).resolves.toBe("ran")
  })
})
