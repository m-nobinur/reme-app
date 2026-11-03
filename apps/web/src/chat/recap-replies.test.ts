// @vitest-environment happy-dom
import {
  type AppendMessage,
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { RECAP_REPLY } from "@workspace/contracts"
import {
  waitsOnRecap,
  waitsToSkip,
} from "@workspace/ui/components/assistant/ask-open"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const call = (args: object, result?: object) => ({
  type: "tool-call",
  toolCallId: "call_ask_open",
  toolName: "ask_open",
  args,
  ...(result ? { result } : {}),
})

it("shows the recap's replies while the recap waits, and never a skip", () => {
  const recap = [call({ about: "recap" })]
  expect(waitsOnRecap(recap)).toBe(true)
  expect(waitsToSkip(recap)).toBe(false)
})

it("not once the recap is answered, nor under any other question", () => {
  expect(waitsOnRecap([call({ about: "recap" }, { answer: "skipped" })])).toBe(
    false
  )
  expect(
    waitsOnRecap([call({ about: "business.audience", skippable: true })])
  ).toBe(false)
  expect(waitsOnRecap(undefined)).toBe(false)
})

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined
      unobserve = () => undefined
      disconnect = () => undefined
    }
  )
  Element.prototype.scrollTo ??= () => undefined
})

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  vi.unstubAllGlobals()
})

const RECAP: ThreadMessageLike[] = [
  {
    id: "msg_recap",
    role: "assistant",
    content: [
      { type: "text", text: "Here's what I've noted for **Pruning Co**:" },
      {
        type: "tool-call",
        toolCallId: "call_recap",
        toolName: "ask_open",
        args: { about: "recap" },
        argsText: '{"about":"recap"}',
      },
    ],
    status: { type: "requires-action", reason: "tool-calls" },
  },
]

/** The thread under a waiting recap, the runtime it runs on and what it sent. */
async function recapThread() {
  const sent: AppendMessage[] = []
  const held: { runtime?: AssistantRuntime } = {}
  function Chat() {
    const runtime = useExternalStoreRuntime({
      messages: RECAP,
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async (message) => {
        sent.push(message)
      },
    })
    held.runtime = runtime
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(Thread, { autoFocus: false })
    )
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(Chat)))
  unmount = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  const pill = (name: string) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === name
    )
  await vi.waitFor(() => expect(pill("Change something")).toBeDefined())
  const composer = container.querySelector("textarea") as HTMLTextAreaElement
  return { pill, composer, sent, runtime: held.runtime as AssistantRuntime }
}

it("Change something starts a correction in the composer, the caret after it, and sends nothing", async () => {
  const { pill, composer, sent } = await recapThread()
  await act(async () => pill("Change something")?.click())
  expect(composer.value).toBe("Change ")
  expect(document.activeElement).toBe(composer)
  expect(composer.selectionStart).toBe("Change ".length)
  expect(composer.selectionEnd).toBe("Change ".length)
  expect(sent).toEqual([])
})

it("Change something keeps a draft the owner already typed", async () => {
  const { pill, composer, runtime } = await recapThread()
  await act(async () => runtime.thread.composer.setText("The area is wrong"))
  await act(async () => pill("Change something")?.click())
  expect(composer.value).toBe("The area is wrong")
  expect(document.activeElement).toBe(composer)
})

it("All correct sends its message straight away", async () => {
  const { pill, sent } = await recapThread()
  await act(async () => pill(RECAP_REPLY)?.click())
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]?.content).toEqual([{ type: "text", text: RECAP_REPLY }])
})
