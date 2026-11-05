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

function Chat({ slot, status }: { slot: HTMLElement; status: string }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => undefined,
  })
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      TraySlotProvider,
      { value: slot },
      createElement(
        "div",
        { "data-slot": "aui_assistant-message-content" },
        createElement("p", { className: "aui-md", "data-status": status }),
        createElement(
          TrayApproval,
          {
            name: "approval",
            no: { label: "Not now", onNo: () => undefined },
            title: "Add it?",
            yes: { label: "Approve", onYes: () => undefined },
          } as never,
          createElement("p", null, "detail")
        )
      )
    )
  )
}

it("docks a question only once the words above it have finished revealing", async () => {
  const chat = document.createElement("div")
  const slot = document.createElement("div")
  document.body.appendChild(chat)
  document.body.appendChild(slot)
  const root = createRoot(chat)
  const render = (status: string) =>
    act(async () => root.render(createElement(Chat, { slot, status })))

  await render("running")
  expect(slot.querySelector('[data-slot="approval"]')).toBeNull()

  await render("complete")
  await act(async () => undefined)
  expect(slot.querySelector('[data-slot="approval"]')).not.toBeNull()
})
