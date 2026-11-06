// @vitest-environment happy-dom
import {
  type AssistantRuntime,
  type ThreadMessageLike,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/lib/api/server", () => ({
  createConversation: vi.fn(),
  getConversation: vi.fn(async () => null),
  getConversationMessages: vi.fn(async () => []),
  listConversations: vi.fn(async () => []),
  updateConversation: vi.fn(),
}))

const { conversationList, MissingConversation } = await import(
  "./conversations"
)

it("reports a conversation the owner cannot open as the thread list's switch error", async () => {
  let runtime: AssistantRuntime | undefined
  const useThread = () =>
    useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async () => undefined,
    })
  const Probe = () => {
    runtime = useRemoteThreadListRuntime({
      adapter: conversationList,
      runtimeHook: useThread,
      threadId: "someone-elses",
    })
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => {
    root.render(createElement(Probe))
  })
  await vi.waitFor(() => {
    const error = runtime?.threads.getState().switchError
    expect(error?.threadId).toBe("someone-elses")
    expect(error?.error).toBeInstanceOf(MissingConversation)
  })
  await act(async () => root.unmount())
})
