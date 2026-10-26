// @vitest-environment happy-dom
import { PanelSegment } from "@workspace/ui/components/live-panel"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

type Props = Parameters<typeof PanelSegment>[0]
const steps = (state: "now" | "waiting" | "done"): Props["steps"] => [
  {
    id: "work",
    label: "What you do",
    state: "done",
    kind: "thinking",
  },
  { id: "area", label: "Where you work", state, kind: "thinking" },
]
const show = (props: Partial<Props>) =>
  act(async () =>
    root.render(
      createElement(PanelSegment, {
        icon: "thinking",
        state: "now",
        title: "Getting Fixture ready",
        steps: steps("now"),
        ...props,
      })
    )
  )
const segment = () => container.querySelector('[data-slot="panel-segment"]')
const title = () => container.querySelector("h3")?.textContent
const caret = () => container.querySelector("button[aria-expanded]")

it("ticks every step, holds, then folds to one line with no caret", async () => {
  await show({ line: "One more, then Ellie starts on your website" })
  expect(caret()?.getAttribute("aria-expanded")).toBe("true")
  expect(container.textContent).toContain("What you do")
  expect(container.textContent).not.toContain("·")

  await show({
    state: "done",
    title: "Fixture is set up",
    working: "Getting Fixture ready",
    steps: steps("done"),
  })
  // Every step ticked, under the working title, for a moment.
  expect(title()).toBe("Getting Fixture ready")
  expect(segment()?.getAttribute("data-state")).toBe("done")
  expect(container.querySelectorAll('li[data-state="done"]')).toHaveLength(2)

  await act(async () => vi.advanceTimersByTimeAsync(1200))
  expect(title()).toBe("Fixture is set up")
  expect(segment()?.getAttribute("data-state")).toBe("folded")
  expect(caret()).toBeNull()
  expect(container.querySelector("[inert]")).not.toBeNull()
})

it("is one line from the start when it was already done", async () => {
  await show({
    state: "done",
    title: "Fixture is set up",
    steps: steps("done"),
  })
  expect(title()).toBe("Fixture is set up")
  expect(segment()?.getAttribute("data-state")).toBe("folded")
  expect(caret()).toBeNull()
})

it("folds and opens its steps from the caret while it runs", async () => {
  await show({})
  await act(async () => (caret() as HTMLButtonElement).click())
  expect(caret()?.getAttribute("aria-expanded")).toBe("false")
  expect(container.querySelector("[inert]")).not.toBeNull()
  await act(async () => (caret() as HTMLButtonElement).click())
  expect(container.querySelector("[inert]")).toBeNull()
})

it("offers no link from a waiting step: the answer goes in the chat", async () => {
  await show({ state: "waiting", steps: steps("waiting") })
  expect(container.querySelectorAll("li button")).toHaveLength(0)
})

it("lists what is done and the step at work, and only hints at the rest", async () => {
  await show({
    steps: [
      ...steps("now"),
      {
        id: "customers",
        label: "Your customers",
        state: "next",
        kind: "question",
      },
    ],
  })
  expect(container.textContent).toContain("Where you work")
  expect(container.textContent).not.toContain("Your customers")
  expect(container.querySelectorAll("ol > li")).toHaveLength(3)
  expect(
    container.querySelector("ol > li:last-child")?.getAttribute("aria-hidden")
  ).toBe("true")
})

it("draws no details under a finished step", async () => {
  await show({
    steps: [
      {
        id: "work",
        label: "Planning",
        state: "done",
        kind: "planning",
        detail: "Warm editorial",
      },
      {
        id: "area",
        label: "Photos",
        state: "now",
        kind: "photos",
        detail: "3 of 8",
      },
    ],
  })
  expect(container.textContent).not.toContain("Warm editorial")
  expect(container.textContent).toContain("3 of 8")
})

it("draws nothing under a job not begun, and only its action when it has one", async () => {
  const upcoming = steps("now").map((step) => ({
    ...step,
    state: "next" as const,
  }))
  const next = {
    state: "upcoming" as const,
    title: "Your website comes next",
    steps: upcoming,
  }
  await show(next)
  expect(container.querySelector('[id$="-steps"]')).toBeNull()
  expect(caret()).toBeNull()

  await show({
    ...next,
    children: createElement("a", { href: "/app" }, "Create my website"),
  })
  expect(container.querySelector("ol")).toBeNull()
  expect(container.textContent).toContain("Create my website")
})
