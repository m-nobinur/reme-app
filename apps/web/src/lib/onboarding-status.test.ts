// @vitest-environment happy-dom
import { ONBOARDING_STATUS, type OnboardingStatus } from "@workspace/contracts"
import {
  clearOnboardingStatus,
  onboardingStatusNow,
  readOnboardingStatus,
  type StatusTurn,
  useOnboardingWait,
  useStatusTurn,
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
  const reme = { seed: "", assistant: "Reme" }
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    vi.useFakeTimers()
    clearOnboardingStatus()
    container = document.createElement("div")
    root = createRoot(container)
    const Line = () => {
      const { status, seconds } = useOnboardingWait()
      return waitingLine(status, seconds, reme).label
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
    expect(line()).toBe("Reme is still working on it")
    await wait(18)
    expect(line()).toBe("Reme is taking longer than usual")
    // The turn's own line, filtered by the api, shows as sent.
    await send({ kind: "doing", text: "Checking your number" })
    expect(line()).toBe("Checking your number")
    await wait(12)
    expect(line()).toBe("Reme is still working on it")
  })

  it("words each status in the order the work comes, one a second at most", async () => {
    await send({ kind: "doing", text: "Noting your services" })
    expect(line()).toBe("Noting your services")
    // The plan's own line replaces code's, a second after it at the soonest.
    await send({ kind: "doing", text: "Looking at the services you offer" })
    expect(line()).toBe("Noting your services")
    await wait(1)
    expect(line()).toBe("Looking at the services you offer")
    // A fact noted after the plan's line follows it, never hidden by it.
    await wait(1)
    await send({ kind: "fact", key: "business.offerings" })
    expect(line()).toBe("Noting your services")
    await wait(12)
    expect(line()).toBe("Reme is still working on it")
  })

  it("shows only the newest of statuses that come in a burst", async () => {
    await send({ kind: "doing", text: "Checking your area" })
    await send({ kind: "fact", key: "service_area.text" })
    await send({ kind: "next", next: "ask_open" })
    expect(line()).toBe("Checking your area")
    await wait(0.5)
    expect(line()).toBe("Checking your area")
    await wait(0.5)
    expect(line()).toBe("Getting the next question ready")
    // A new turn starts with no line held over.
    await act(async () => clearOnboardingStatus())
    await send({ kind: "doing", text: "Reading your answer" })
    expect(line()).toBe("Reading your answer")
  })

  it("with no status, goes from reading to longer than usual, never thinking", async () => {
    expect(line()).toBe("Reme is reading your message")
    await wait(4)
    expect(line()).toMatch(
      /^Reme is (looking into it|working on it|working out what to do)$/
    )
    await wait(8)
    expect(line()).toBe("Reme is still working on it")
    await wait(18)
    expect(line()).toBe("Reme is taking longer than usual")
  })
})

describe("the turn's clock and lines", () => {
  const read = (data: Partial<OnboardingStatus>) =>
    readOnboardingStatus(
      { type: ONBOARDING_STATUS, data: { facts: [], ...data } },
      () => undefined
    )
  let turn: StatusTurn = { since: null, lines: [] }
  let root: Root

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    clearOnboardingStatus()
    root = createRoot(document.createElement("div"))
    const Probe = () => {
      turn = useStatusTurn()
      return null
    }
    await act(async () => root.render(createElement(Probe)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    clearOnboardingStatus()
    vi.useRealTimers()
  })

  it("counts from the turn's start as the api sent it, and keeps the lines it showed and finished steps", async () => {
    await act(async () => {
      read({
        on: { kind: "doing", text: "Checking Tuesday's diary" },
        ms: 1_700,
      })
    })
    expect(turn.since).toBe(98_300)
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      // A later status never moves the start.
      read({
        on: { kind: "doing", text: "Reading last week's clicks" },
        ms: 2_000,
        past: true,
      })
      read({ on: { kind: "thinking", text: "Weighing it" }, ms: 2_500 })
    })
    expect(turn).toEqual({
      since: 98_300,
      lines: ["Checking Tuesday's diary", "Reading last week's clicks"],
    })
    // A finished step is never the line shown now.
    expect(onboardingStatusNow()).toEqual({
      kind: "thinking",
      text: "Weighing it",
    })
    await act(async () => clearOnboardingStatus())
    expect(turn).toEqual({ since: null, lines: [] })
  })
})
