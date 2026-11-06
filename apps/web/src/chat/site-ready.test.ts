// @vitest-environment happy-dom
import {
  PUBLISH_LATE_MS,
  SiteReady,
} from "@workspace/ui/components/assistant/site-ready"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The ready card docks into its row of the update stack once the owner writes. It moves
 * there as the same node, so nothing in it is drawn again, and an opened
 * card closes on the owner's next message without a remount.
 */

afterEach(() => {
  document.body.innerHTML = ""
})

it("moves into the tray as the same card, its first row alone", async () => {
  const tray = document.createElement("div")
  const chat = document.createElement("div")
  document.body.appendChild(chat)
  document.body.appendChild(tray)
  const root = createRoot(chat)
  const draw = (docked: boolean) =>
    act(async () =>
      root.render(
        createElement(SiteReady, {
          docked,
          meta: "Ready now",
          onApprove: () => undefined,
          onMakeChanges: () => undefined,
          pictures: null,
          preview: "loading",
          spot: tray,
          title: "Sparkle website",
        })
      )
    )

  await draw(false)
  const card = chat.querySelector("article")
  expect(card).not.toBeNull()
  expect(tray.querySelector("article")).toBeNull()

  await draw(true)
  expect(tray.querySelector("article")).toBe(card)
  expect(chat.querySelector("article")).toBeNull()
  // The panel keeps the preview, so docked it never opens one.
  expect(tray.querySelector("button[aria-expanded]")).toBeNull()
  expect(tray.textContent).not.toContain("Request changes")

  await act(async () => root.unmount())
  expect(tray.childElementCount).toBe(0)
})

it("holds its picture's place with the site's name, still", async () => {
  const chat = document.createElement("div")
  document.body.appendChild(chat)
  const root = createRoot(chat)
  await act(async () =>
    root.render(
      createElement(SiteReady, {
        meta: "Ready now",
        onApprove: () => undefined,
        onMakeChanges: () => undefined,
        pictures: null,
        preview: "loading",
        title: "Sparkle website",
      })
    )
  )
  const shot = chat.querySelector("[data-slot=shot]")
  expect(shot?.textContent).toBe("Sparkle website")
  expect(shot?.querySelector("[data-slot=diffusing]")).toBeNull()
  await act(async () => root.unmount())
})

it("says a publish is slow to come online once the load check runs long, until it is live", async () => {
  vi.useFakeTimers()
  const chat = document.createElement("div")
  document.body.appendChild(chat)
  const root = createRoot(chat)
  const draw = (published: boolean, live: boolean) =>
    act(async () =>
      root.render(
        createElement(SiteReady, {
          approved: true,
          published,
          live,
          meta: "",
          onApprove: () => undefined,
          onMakeChanges: () => undefined,
          pictures: null,
          preview: "loading",
          title: "Sparkle website",
        })
      )
    )
  const line = () =>
    chat.querySelector("[data-slot=status-line-text]")?.textContent
  // Still publishing: no load check yet, so never late.
  await draw(false, false)
  await act(async () => vi.advanceTimersByTime(PUBLISH_LATE_MS + 5000))
  expect(line()).toBe("Approved, publishing your website")
  await draw(true, false)
  await act(async () => vi.advanceTimersByTime(5000))
  expect(line()).toBe("Published, checking your website loads")
  await act(async () => vi.advanceTimersByTime(PUBLISH_LATE_MS))
  expect(line()).toBe(
    "Your website is taking longer than usual to come online. I'll tell you when it's live"
  )
  await draw(true, true)
  await act(async () => vi.advanceTimersByTime(5000))
  expect(line()).toBe("Published")
  await act(async () => root.unmount())
  vi.useRealTimers()
})

it("says why Publish waits while an update to the draft is being made", async () => {
  const chat = document.createElement("div")
  document.body.appendChild(chat)
  const root = createRoot(chat)
  const render = (held: boolean) =>
    act(async () =>
      root.render(
        createElement(SiteReady, {
          held,
          meta: "Not published",
          onApprove: () => undefined,
          onMakeChanges: () => undefined,
          pictures: null,
          preview: "loading",
          title: "Sparkle website",
        })
      )
    )
  await render(true)
  const publish = [...chat.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Publish"
  )
  expect(publish?.disabled).toBe(true)
  expect(chat.textContent).toContain(
    "Publishing waits until your update is ready."
  )
  await render(false)
  expect(chat.textContent).not.toContain("Publishing waits")
  await act(async () => root.unmount())
})
