// @vitest-environment happy-dom
import { COS_TOOLS } from "@workspace/contracts"
import { COS_READS } from "@workspace/ui/components/assistant/cos-tools"
import { STEPPED, stepText, toolLine } from "@workspace/ui/lib/activity-copy"
import { SHOW_DELAY_MS } from "@workspace/ui/lib/status-line"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IN_FLIGHT_MS } from "./in-flight"
import { partialStep } from "./still-working"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: "01TURN", status: { type: "running" } } }),
}))

const STEP = "Checking the records for sparkleclean.co.uk"
const INPUT = { name: "sparkleclean.co.uk", step: STEP }

/** What the call's line says after `SHOW_DELAY_MS`, for a check_domain call as the thread holds it. */
async function lineOf(args: object, argsText: string) {
  vi.useFakeTimers()
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      createElement(
        COS_READS.check_domain as never,
        {
          toolName: "check_domain",
          toolCallId: "call-1",
          args,
          argsText,
        } as never
      )
    )
  )
  await act(async () => vi.advanceTimersByTime(SHOW_DELAY_MS + 50))
  const text = container.textContent
  await act(async () => root.unmount())
  return text
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.useRealTimers())

describe("a slow read's step in the chat", () => {
  it("shows the line the model wrote while the call runs", async () => {
    expect(await lineOf(INPUT, JSON.stringify(INPUT))).toContain(STEP)
  })

  it("keeps the fixed line while the input is still streaming", async () => {
    // A streaming input's text stops before its closing brace.
    const streaming = JSON.stringify(INPUT).slice(0, -1)
    const text = await lineOf(
      { name: INPUT.name, step: "Checking the rec" },
      streaming
    )
    expect(text).not.toContain("Checking the rec")
    expect(text).toMatch(/sparkleclean\.co\.uk/)
  })

  it("keeps the fixed line when the call has no step", async () => {
    const bare = { name: INPUT.name }
    const text = await lineOf(bare, JSON.stringify(bare))
    expect(text).toMatch(/^(Checking|Looking)/)
    expect(text).toContain("sparkleclean.co.uk")
    expect(text).toBe(
      toolLine(
        "check_domain",
        "working",
        { domain: INPUT.name },
        { seed: "01TURN" }
      )
    )
  })

  it("is the line for working only, and for the slow reads only", () => {
    expect(toolLine("check_domain", "working", { step: STEP })).toBe(STEP)
    expect(toolLine("check_domain", "done", { step: STEP })).not.toContain(STEP)
    expect(toolLine("check_domain", "still", { step: STEP })).not.toContain(
      STEP
    )
    expect(stepText("get_facts", STEP)).toBeNull()
    expect(stepText("request_change", STEP)).toBeNull()
  })

  it("cleans the line like any argument: no ids, no dashes", () => {
    expect(
      stepText("find_domain", "0f8f8431-aaaa-bbbb-cccc-1234567890ab")
    ).toBeNull()
    expect(stepText("find_domain", "Looking — for names")).toBe(
      "Looking, for names"
    )
  })

  it("covers the tools whose input takes a step, and request_change's panel step is not one", () => {
    const takes = Object.entries(COS_TOOLS)
      .filter(
        ([name, tool]) =>
          "step" in tool.input.shape && name !== "request_change"
      )
      .map(([name]) => name)
    expect([...STEPPED].sort()).toEqual(takes.sort())
  })
})

describe("a turn cut off with its continuation queued", () => {
  const NOW = Date.parse("2026-10-30T12:00:00Z")
  const call = (step?: string) => {
    const args = { name: "sparkleclean.co.uk", ...(step && { step }) }
    return {
      type: "tool-call",
      toolName: "check_domain",
      args,
      argsText: JSON.stringify(args),
    }
  }
  const said = (content: object[], custom: Record<string, unknown> = {}) => ({
    role: "assistant",
    content: content as never,
    metadata: {
      custom: {
        createdAt: new Date(NOW - 5_000).toISOString(),
        partial: true,
        ...custom,
      },
    },
  })

  it("shows its last step until the continuation posts", () => {
    expect(
      partialStep([said([call("Looking at the first page"), call(STEP)])], NOW)
    ).toBe(STEP)
    expect(partialStep([said([call(STEP), call()])], NOW)).toBe(STEP)
  })

  it("has no step to show when the model wrote none", () => {
    expect(partialStep([said([call()])], NOW)).toBeNull()
  })

  it("is nothing once the continuation or the owner has posted, or after too long", () => {
    const partial = said([call(STEP)])
    expect(
      partialStep(
        [
          partial,
          {
            ...partial,
            metadata: {
              custom: { createdAt: partial.metadata.custom.createdAt },
            },
          },
        ],
        NOW
      )
    ).toBeUndefined()
    expect(
      partialStep(
        [partial, { role: "user", content: [], metadata: { custom: {} } }],
        NOW
      )
    ).toBeUndefined()
    expect(partialStep([partial], NOW + IN_FLIGHT_MS)).toBeUndefined()
    expect(partialStep([], NOW)).toBeUndefined()
  })
})
