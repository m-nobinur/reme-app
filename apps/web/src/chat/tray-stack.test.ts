// @vitest-environment happy-dom
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { TrayApproval } from "@workspace/ui/components/assistant/decision"
import { TraySlotProvider } from "@workspace/ui/components/assistant/question-tray"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Two items docked at once: the tray shows the newest, says "1 of 2", and
 * steps to the older one, which was kept drawn and hidden.
 */

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
})

afterEach(() => {
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

function Chat({ slot, onYes }: { slot: HTMLElement; onYes: () => void }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  const item = (title: string) =>
    createElement(
      TrayApproval,
      {
        key: title,
        name: "approval",
        no: { label: "Not now", onNo: () => undefined },
        title,
        yes: { label: "Approve", onYes },
      } as never,
      createElement("p", null, `${title} detail`)
    )
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(TraySlotProvider, { value: slot }, [
      item("Older ask"),
      item("Newer ask"),
    ])
  )
}

it("shows the newest item first and steps to the older one", async () => {
  const chat = document.createElement("div")
  const slot = document.createElement("div")
  document.body.appendChild(chat)
  document.body.appendChild(slot)
  const root = createRoot(chat)
  const onYes = vi.fn()
  await act(async () => root.render(createElement(Chat, { slot, onYes })))

  const items = () =>
    [...slot.querySelectorAll<HTMLElement>('[data-slot="approval"]')].map(
      (each) => ({
        title: each.querySelector("h2")?.textContent,
        shown: each.style.display !== "none",
      })
    )
  const press = (label: string) =>
    act(async () =>
      slot
        .querySelector<HTMLButtonElement>(
          `[data-slot="approval"]:not([style*="none"]) button[aria-label="${label}"]`
        )
        ?.click()
    )

  // The slot's order is the order they were drawn in; only one shows.
  const shown = () =>
    Object.fromEntries(items().map((each) => [each.title, each.shown]))

  expect(shown()).toEqual({ "Older ask": false, "Newer ask": true })
  expect(slot.textContent).toContain("1 of 2")

  await press("Older")
  expect(shown()).toEqual({ "Older ask": true, "Newer ask": false })
  expect(slot.textContent).toContain("2 of 2")

  await press("Newer")
  expect(items().find((each) => each.shown)?.title).toBe("Newer ask")

  await act(async () => root.unmount())
  expect(slot.childElementCount).toBe(0)
})
