// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { EMPTY_WORKSPACE } from "./attention"
import { type TabBadge, tabBadge, useTabTitle } from "./tab-icon"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("dots the tab when something waits on the owner, else while the assistant works", () => {
  expect(tabBadge(null)).toBeNull()
  expect(tabBadge(EMPTY_WORKSPACE)).toBeNull()
  expect(tabBadge({ ...EMPTY_WORKSPACE, building: true })).toBe("working")
  const asked = {
    ...EMPTY_WORKSPACE,
    building: true,
    attention: [{ kind: "question" }] as never,
  }
  expect(tabBadge(asked)).toBe("waiting")
  const segment = (kind: string, state: string) =>
    ({ id: kind, kind, state, steps: [], at: "" }) as never
  const journey = (...segments: never[]) => ({
    ...EMPTY_WORKSPACE,
    activity: {
      journey: segments,
      now: [],
      waiting: [],
      upcoming: [],
      done: [],
    },
  })
  expect(tabBadge(journey(segment("onboarding", "waiting")))).toBe("waiting")
  expect(tabBadge(journey(segment("onboarding", "now")))).toBeNull()
  expect(tabBadge(journey(segment("website", "now")))).toBe("working")
})

it("names the assistant in a background tab's title while an answer waits, and restores it in front", async () => {
  let hidden = true
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  })
  const turn = (to: boolean) => {
    hidden = to
    document.dispatchEvent(new Event("visibilitychange"))
  }
  document.title = "Chat · Reme"
  const root = createRoot(document.createElement("div"))
  const Title = ({ badge }: { badge: TabBadge }) => {
    useTabTitle("Ava", badge)
    return null
  }
  await act(async () => root.render(createElement(Title, { badge: "waiting" })))
  expect(document.title).toBe("Ava needs your answer · Reme")
  turn(false)
  expect(document.title).toBe("Chat · Reme")
  turn(true)
  expect(document.title).toBe("Ava needs your answer · Reme")
  // Answered: the page's own title comes back, and a hidden tab keeps it.
  await act(async () => root.render(createElement(Title, { badge: null })))
  expect(document.title).toBe("Chat · Reme")
  turn(true)
  expect(document.title).toBe("Chat · Reme")
  await act(async () => root.unmount())
})
