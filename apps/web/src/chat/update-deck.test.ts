// @vitest-environment happy-dom
import {
  DWELL_MS,
  UpdatePager,
} from "@workspace/ui/components/assistant/update-deck"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * A conversation's stack on a fake clock: each step waits a fresh 3 to 6
 * seconds, holds while the pointer is on it or focus is in it, stops for
 * good after an arrow, and never moves by itself under reduced motion.
 */

let reduced = false
let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query.includes("reduce"),
  }))
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const UPDATES = ["Site", "Question", "Reminder"].map((title) => ({
  id: title,
  content: createElement("button", { type: "button" }, title),
}))

const open = async () => {
  await act(async () =>
    root.render(createElement(UpdatePager, { updates: UPDATES }))
  )
}
const front = () => host.querySelector("[data-front]")?.textContent
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms))
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)

it("waits a random 3 to 6 seconds before each step", async () => {
  // Each dwell is drawn as the one before it ends, so set the next draw first.
  const draw = vi.spyOn(Math, "random").mockReturnValue(0)
  await open()
  expect(front()).toBe("Site")
  // The shortest draw: 3 seconds.
  await wait(DWELL_MS.min - 1)
  expect(front()).toBe("Site")
  draw.mockReturnValue(1)
  await wait(1)
  expect(front()).toBe("Question")
  // The longest: 6 seconds.
  await wait(DWELL_MS.max - 1)
  expect(front()).toBe("Question")
  draw.mockReturnValue(0.5)
  await wait(1)
  expect(front()).toBe("Reminder")
  // In between, and round to the first again.
  await wait(4499)
  expect(front()).toBe("Reminder")
  await wait(1)
  expect(front()).toBe("Site")
})

it("holds while the pointer is on it and moves on once it leaves", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0)
  await open()
  const deck = host.querySelector("section")
  await act(async () => {
    deck?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))
  })
  await wait(DWELL_MS.max * 3)
  expect(front()).toBe("Site")
  await act(async () => {
    deck?.dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        relatedTarget: document.body,
      })
    )
  })
  await wait(DWELL_MS.min)
  expect(front()).toBe("Question")
})

it("holds while focus is inside it", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0)
  await open()
  host.querySelector<HTMLButtonElement>("[data-front] button")?.focus()
  await wait(DWELL_MS.max * 3)
  expect(front()).toBe("Site")
  ;(document.activeElement as HTMLElement).blur()
  await wait(DWELL_MS.min)
  expect(front()).toBe("Question")
})

it("stops moving on its own once the owner uses an arrow", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0)
  await open()
  await act(async () => button("Next update")?.click())
  expect(front()).toBe("Question")
  // The arrow keeps focus, so move it off: the stop must hold by itself.
  ;(document.activeElement as HTMLElement).blur()
  await wait(DWELL_MS.max * 5)
  expect(front()).toBe("Question")
  await act(async () => button("Previous update")?.click())
  expect(front()).toBe("Site")
})

it("never moves by itself under reduced motion, and its arrows still work", async () => {
  reduced = true
  await open()
  await wait(DWELL_MS.max * 5)
  expect(front()).toBe("Site")
  await act(async () => button("Previous update")?.click())
  expect(front()).toBe("Reminder")
})
