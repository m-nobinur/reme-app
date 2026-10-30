// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { TraySlotProvider } from "@workspace/ui/components/assistant/question-tray"
import {
  PUBLISH_LATE_MS,
  SiteReady,
} from "@workspace/ui/components/assistant/site-ready"
import { act, createElement, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The ready card docks above the composer once the owner writes. It moves
 * there as the same node, so nothing in it is drawn again, and an opened
 * card closes on the owner's next message without a remount.
 */

afterEach(() => {
  document.body.innerHTML = ""
})

/** An empty thread, which the docked card's tray item reads. */
function Runtime({ children }: { children: ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  return createElement(AssistantRuntimeProvider, { runtime }, children)
}

it("moves into the tray as the same card and closes on a new message", async () => {
  const tray = document.createElement("div")
  const chat = document.createElement("div")
  document.body.appendChild(chat)
  document.body.appendChild(tray)
  const root = createRoot(chat)
  const draw = (docked: boolean, closeOn: string | null) =>
    act(async () =>
      root.render(
        createElement(
          Runtime,
          null,
          createElement(
            TraySlotProvider,
            { value: tray },
            createElement(SiteReady, {
              closeOn,
              docked,
              meta: "Ready now",
              onApprove: () => undefined,
              onMakeChanges: () => undefined,
              pictures: null,
              preview: "loading",
              title: "Sparkle website",
            })
          )
        )
      )
    )

  await draw(false, null)
  const card = chat.querySelector("article")
  expect(card).not.toBeNull()
  expect(tray.querySelector("article")).toBeNull()

  await draw(true, "2026-10-25T10:00:00Z")
  expect(tray.querySelector("article")).toBe(card)
  expect(chat.querySelector("article")).toBeNull()

  const row = tray.querySelector("button[aria-expanded]")
  await act(async () => (row as HTMLButtonElement).click())
  expect(row?.getAttribute("aria-expanded")).toBe("true")

  await draw(true, "2026-10-25T10:05:00Z")
  expect(tray.querySelector("article")).toBe(card)
  expect(row?.getAttribute("aria-expanded")).toBe("false")

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
