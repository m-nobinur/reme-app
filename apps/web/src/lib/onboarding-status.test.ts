// @vitest-environment happy-dom
import { ONBOARDING_STATUS, type OnboardingStatus } from "@workspace/contracts"
import {
  clearOnboardingStatus,
  readOnboardingStatus,
  useOnboardingWait,
} from "@workspace/ui/hooks/use-onboarding-status"
import { waitingLine } from "@workspace/ui/lib/activity-copy"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("an onboarding status part", () => {
  it("reads the panel again only when it names facts already written", () => {
    const refresh = vi.fn()
    const part = (data: unknown) => ({ type: ONBOARDING_STATUS, data })
    expect(
      readOnboardingStatus(
        part({ on: { kind: "fact", key: "business.offerings" }, facts: [] }),
        refresh
      )
    ).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    readOnboardingStatus(
      part({
        on: { kind: "next", next: "ask_open" },
        facts: ["business.offerings"],
      }),
      refresh
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    // A part it cannot read is still the status's, and does nothing.
    expect(readOnboardingStatus(part({ on: "x" }), refresh)).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("leaves every other data part to the chat", () => {
    expect(
      readOnboardingStatus(
        { type: "data-card_answered", data: { tool_call_id: "c" } },
        vi.fn()
      )
    ).toBe(false)
  })
})

describe("the waiting line as a turn goes on", () => {
  const ellie = { seed: "", assistant: "Ellie" }
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    vi.useFakeTimers()
    clearOnboardingStatus()
    container = document.createElement("div")
    root = createRoot(container)
    const Line = () => {
      const { status, seconds } = useOnboardingWait()
      return waitingLine(status, seconds, ellie).label
    }
    await act(async () => root.render(createElement(Line)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    clearOnboardingStatus()
    vi.useRealTimers()
  })

  const line = () => container.textContent
  const wait = (seconds: number) =>
    act(async () => vi.advanceTimersByTime(seconds * 1000))
  const send = (on: OnboardingStatus["on"]) =>
    act(async () => {
      readOnboardingStatus(
        { type: ONBOARDING_STATUS, data: { on, facts: [] } },
        () => undefined
      )
    })

  it("names the step, moves on only while nothing new comes, and starts again on news", async () => {
    await send({ kind: "step", step: "contact", answered: true })
    expect(line()).toBe("Noting your phone and email")
    await wait(11.9)
    expect(line()).toBe("Noting your phone and email")
    await wait(0.1)
    expect(line()).toBe("Ellie is still working on it")
    await wait(18)
    expect(line()).toBe("Ellie is taking longer than usual")
    // The planner's own line is model text: the catalogue words it.
    await send({ kind: "doing", text: "Checking your number" })
    expect(line()).toBe("Working on your answer")
    await wait(12)
    expect(line()).toBe("Ellie is still working on it")
  })

  it("words each status from the catalogue, in the order the work comes", async () => {
    await send({ kind: "step", step: "business.offerings", answered: false })
    expect(line()).toBe("Looking at your services")
    await send({ kind: "thinking", text: "Evaluating service models" })
    expect(line()).toBe("Thinking it through")
    await wait(12)
    expect(line()).toBe("Ellie is still working on it")
    await send({ kind: "doing", text: "Checking your services" })
    expect(line()).toBe("Working on your answer")
    // A fact noted after the planner's line follows it, never hidden by it.
    await send({ kind: "fact", key: "business.offerings" })
    expect(line()).toBe("Noting your services")
  })

  it("with no status, goes from reading to longer than usual, never thinking", async () => {
    expect(line()).toBe("Ellie is reading your message")
    await wait(4)
    expect(line()).toMatch(
      /^Ellie is (looking into it|working on it|working out what to do)$/
    )
    await wait(8)
    expect(line()).toBe("Ellie is still working on it")
    await wait(18)
    expect(line()).toBe("Ellie is taking longer than usual")
  })
})
