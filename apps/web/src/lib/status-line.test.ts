// @vitest-environment happy-dom
import {
  type StatusKind,
  StatusLine,
} from "@workspace/ui/components/status-line"
import { foldLines, holdFor } from "@workspace/ui/lib/status-line"
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

type Props = Partial<Parameters<typeof StatusLine>[0]>
const show = (props: Props) =>
  act(async () =>
    root.render(
      createElement(StatusLine, {
        kind: "checking" as StatusKind,
        label: "Checking your DNS",
        ...props,
      })
    )
  )
const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))
const text = () => container.textContent

it("folds identical lines in a row and counts them", () => {
  expect(foldLines(["a", "a", "b", "a"])).toEqual([
    { label: "a", count: 2 },
    { label: "b", count: 1 },
    { label: "a", count: 1 },
  ])
})

it("holds a working line to its minimum, and lets a failure through", () => {
  expect(holdFor("working", "done", 1000, 1500)).toBe(1500)
  expect(holdFor("working", "done", 1000, 3500)).toBe(0)
  expect(holdFor("working", "failed", 1000, 1100)).toBe(0)
  expect(holdFor("working", "waiting", 1000, 1100)).toBe(0)
  expect(holdFor("done", "working", 1000, 1100)).toBe(0)
})

it("shows a working line only after its delay", async () => {
  await show({})
  expect(text()).toBe("")
  await wait(299)
  expect(text()).toBe("")
  await wait(1)
  expect(text()).toBe("Checking your DNS")
})

it("never shows a line for work that ended before the delay", async () => {
  await show({})
  await wait(100)
  await show({ label: "Checked your DNS", state: "done" })
  expect(text()).toBe("Checked your DNS")
  expect(container.textContent).not.toContain("Checking")
})

it("keeps the working words for two seconds, then says it is done", async () => {
  await show({})
  await wait(300)
  await wait(500)
  await show({ label: "Checked your DNS", state: "done" })
  expect(text()).toBe("Checking your DNS")
  await wait(1499)
  expect(text()).toBe("Checking your DNS")
  await wait(1)
  expect(text()).toBe("Checked your DNS")
})

it("replaces a working line at once when the work fails", async () => {
  await show({})
  await wait(300)
  await show({ label: "Couldn't reach Cloudflare", state: "failed" })
  expect(text()).toBe("Couldn't reach Cloudflare")
})

it("shimmers and moves only while working, and speaks only its words", async () => {
  await show({ delay: 0, count: 3 })
  const words = container.querySelector('[data-slot="status-line-text"]')
  expect(words?.className).toContain("shimmer-color-primary")
  expect(words?.getAttribute("aria-live")).toBe("polite")
  expect(words?.textContent).toBe("Checking your DNS")
  expect(text()).toContain("×3")
  expect(container.querySelector("svg")?.getAttribute("class")).toContain(
    "animate-status-sweep"
  )
  await show({ delay: 0, state: "done", label: "Checked your DNS" })
  await wait(2000)
  expect(
    container.querySelector('[data-slot="status-line-text"]')?.className
  ).not.toContain("shimmer")
  expect(container.querySelector("svg")?.getAttribute("class")).not.toContain(
    "animate-status-sweep"
  )
})

it("shows the clock only after the chat threshold", async () => {
  await show({ delay: 0 })
  expect(text()).toBe("Checking your DNS")
  await wait(14_000)
  expect(text()).toBe("Checking your DNS")
  await wait(2000)
  expect(text()).toBe("Checking your DNS16 s")
})
