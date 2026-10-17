// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import {
  GoogleNotice,
  googleResult,
  useGoogleResult,
} from "@/lib/google-notice"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("reads only the five results the callback sends", () => {
  for (const each of [
    "connected",
    "cancelled",
    "failed",
    "scopes_missing",
    "unavailable",
  ]) {
    expect(googleResult(each)).toBe(each)
  }
  for (const other of ["", "toString", "CONNECTED", 1, null, undefined, []]) {
    expect(googleResult(other)).toBeUndefined()
  }
})

/** The notice as the app wires it: a result in the address, a clear callback. */
function Page({
  result,
  clear,
}: {
  result: Parameters<typeof useGoogleResult>[0]
  clear: () => void
}) {
  const [shown, dismiss] = useGoogleResult(result, clear)
  return createElement(GoogleNotice, { result: shown, onDismiss: dismiss })
}

it("says each result once, announced, and drops it from the address", async () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  const clear = vi.fn()
  await act(async () =>
    root.render(createElement(Page, { result: "scopes_missing", clear }))
  )
  const alert = container.querySelector('[data-slot="alert"]')
  expect(alert?.getAttribute("role")).toBe("alert")
  expect(alert?.textContent).toContain("leave both boxes ticked")
  expect(clear).toHaveBeenCalledTimes(1)

  // The address no longer carries it, and the page still shows it.
  await act(async () =>
    root.render(createElement(Page, { result: undefined, clear }))
  )
  expect(container.textContent).toContain("leave both boxes ticked")

  const dismiss = container.querySelector("button")
  expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss")
  await act(async () => dismiss?.click())
  expect(container.textContent).toBe("")
  await act(async () => root.unmount())
})

it("is polite for a good result and says nothing for none", async () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(createElement(Page, { result: "connected", clear: vi.fn() }))
  )
  expect(
    container.querySelector('[data-slot="alert"]')?.getAttribute("role")
  ).toBe("status")
  await act(async () =>
    root.render(
      createElement(GoogleNotice, { result: undefined, onDismiss: vi.fn() })
    )
  )
  expect(container.textContent).toBe("")
  await act(async () => root.unmount())
})
