// @vitest-environment happy-dom
import { StatusLine, ToolStatus } from "@workspace/ui/components/status-line"
import { FADE_MS, foldLines, holdFor } from "@workspace/ui/lib/status-line"
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
        label: "Checking your DNS",
        ...props,
      })
    )
  )
const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))
const text = () => container.textContent
/** The words the line says now, without the ones fading out. */
const said = () =>
  container.querySelector('[data-slot="status-line-text"]')?.textContent
const outgoing = () =>
  container.querySelector('[data-slot="status-line-outgoing"]')

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
  await wait(199)
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
  await wait(200)
  await wait(500)
  await show({ label: "Checked your DNS", state: "done" })
  expect(text()).toBe("Checking your DNS")
  await wait(1499)
  expect(text()).toBe("Checking your DNS")
  await wait(1)
  expect(said()).toBe("Checked your DNS")
  await wait(FADE_MS)
  expect(text()).toBe("Checked your DNS")
})

it("replaces a working line at once when the work fails", async () => {
  await show({})
  await wait(300)
  await show({ label: "Couldn't reach Cloudflare", state: "failed" })
  expect(said()).toBe("Couldn't reach Cloudflare")
})

it("fades the old words out as the new fade in, outside the live region", async () => {
  await show({ delay: 0 })
  await wait(2000)
  await show({ delay: 0, label: "Checking your email records" })
  expect(said()).toBe("Checking your email records")
  expect(outgoing()?.textContent).toBe("Checking your DNS")
  expect(outgoing()?.getAttribute("aria-hidden")).toBe("true")
  expect(outgoing()?.className).toContain("fade-out-0")
  expect(outgoing()?.className).toContain("motion-reduce:hidden")
  expect(
    container.querySelector('[data-slot="status-line-text"] > span')?.className
  ).toContain("motion-safe:fade-in-0")
  await wait(FADE_MS)
  expect(outgoing()).toBeNull()
  expect(text()).toBe("Checking your email records")
})

it("draws no mark once done, and keeps one for a failure or a wait", async () => {
  await show({ delay: 0, state: "done", label: "Checked your DNS" })
  expect(container.querySelector("svg")).toBeNull()
  await show({ delay: 0, state: "failed", label: "Couldn't check your DNS" })
  expect(container.querySelector("svg")).not.toBeNull()
  await show({ delay: 0, state: "waiting", label: "Ready for your yes" })
  expect(container.querySelector("svg")).not.toBeNull()
})

it("moves a tool's own icon at work, not the working dots", async () => {
  await act(async () =>
    root.render(
      createElement(ToolStatus, {
        delay: 0,
        state: "working",
        tool: "check_domain",
      })
    )
  )
  expect(container.querySelector("svg")).not.toBeNull()
  expect(container.querySelectorAll("svg circle")).toHaveLength(0)
})

it("shimmers and moves only while working, and speaks only its words", async () => {
  await show({ delay: 0, count: 3 })
  const words = container.querySelector('[data-slot="status-line-text"]')
  expect(words?.innerHTML).toContain("shimmer-color-foreground")
  expect(words?.getAttribute("aria-live")).toBe("polite")
  expect(words?.textContent).toBe("Checking your DNS")
  expect(text()).toContain("×3")
  expect(container.querySelectorAll("svg circle")).toHaveLength(3)
  await show({ delay: 0, state: "done", label: "Checked your DNS" })
  await wait(2000)
  expect(
    container.querySelector('[data-slot="status-line-text"]')?.innerHTML
  ).not.toContain("shimmer")
  expect(container.querySelectorAll("svg circle")).toHaveLength(0)
})

it("shows the clock only after the chat threshold", async () => {
  await show({ delay: 0 })
  expect(text()).toBe("Checking your DNS")
  await wait(14_000)
  expect(text()).toBe("Checking your DNS")
  await wait(2000)
  expect(text()).toBe("Checking your DNS16 s")
})
