// @vitest-environment happy-dom

import {
  ChangeAnswer,
  SetupOpenProvider,
} from "@workspace/ui/components/assistant/change-answer"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// A stand-in for assistant-ui's store: what is checked is the button.
const store = vi.hoisted(() => ({ append: vi.fn() }))
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ thread: { isRunning: false } }),
  useAui: () => ({ thread: () => ({ append: store.append }) }),
}))

const host = document.createElement("div")
document.body.appendChild(host)
const root = createRoot(host)
afterEach(() => {
  act(() => root.render(null))
  store.append.mockClear()
})

const show = (step: string, open: boolean) =>
  act(() =>
    root.render(
      createElement(
        SetupOpenProvider,
        { value: open },
        createElement(ChangeAnswer, { step })
      )
    )
  )

it("offers Change on an answered step during onboarding, and says so as the owner", () => {
  show("contact", true)
  const button = host.querySelector("button")
  expect(button?.getAttribute("aria-label")).toBe("Change my contact details")
  act(() => button?.click())
  expect(store.append).toHaveBeenCalledWith(
    "I'd like to change my contact details"
  )
})

it("shows nothing once onboarding is over, or for a step that cannot be reopened", () => {
  show("contact", false)
  expect(host.querySelector("button")).toBeNull()
  for (const step of ["build_for_me", "palette", "design"]) {
    show(step, true)
    expect(host.querySelector("button")).toBeNull()
  }
})
