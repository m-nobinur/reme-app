import { useChat } from "@ai-sdk/react"
import {
  type DictationAdapter,
  type ThreadSuggestion,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { ChatRequest } from "@workspace/contracts"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import { DefaultChatTransport } from "ai"
import { useRef, useState } from "react"
import { getConversationMessages } from "@/lib/api/server"
import { toUIMessage } from "./history"
import { cancelOvertaken, chatFetch, chatTurn, sendsOn, textOf } from "./turn"

/**
 * One stored conversation's runtime: the AI SDK chat under assistant-ui,
 * assembled here rather than through `useChatRuntime`, which in
 * @assistant-ui/react-ai-sdk 1.4.7 does not pass `cancelPendingToolCallsOnSend`
 * through. That option, left on, turns a "not now" into "cancelled" on the
 * owner's next message while the stored row keeps "not now", so a reload
 * disagreed with what the owner had just seen. `cancelOvertaken` cancels what
 * `apps/api` cancels and nothing else.
 */

export function useConversationRuntime({
  mode,
  onFinish,
  suggestions,
  dictation,
}: {
  mode: () => ChatRequest["mode"]
  onFinish: () => void
  suggestions: ThreadSuggestion[]
  dictation: DictationAdapter | undefined
}) {
  const aui = useAui()
  const id = useAuiState((s) => s.threadListItem.id)
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        fetch: chatFetch,
        // The whole body is the turn: no history, system prompt or tools
        // ever leave the browser.
        prepareSendMessagesRequest: async ({ messages }) => {
          const { remoteId } = await aui.threadListItem.initialize()
          return { body: chatTurn(remoteId, mode(), messages) }
        },
      })
  )
  // A failed turn leaves the screen ahead of the stored row: the answer or
  // the yes already shows, and nothing retries it. So the thread goes back
  // to exactly what is stored, with the card open again and the error
  // inline, and a typed message goes back into the composer. Through a ref,
  // because the chat keeps the first `onError` it is given.
  const restore = useRef<(error: Error) => void>(() => undefined)
  const chat = useChat({
    id,
    transport,
    sendAutomaticallyWhen: sendsOn,
    onFinish,
    onError: (error) => restore.current(error),
  })
  restore.current = (error) => {
    const remoteId = aui.threadListItem.getState().remoteId
    // A session that ended can read nothing back; the error offers sign-in.
    if (!remoteId || error.message === SESSION_ENDED) return
    const last = chat.messages.at(-1)
    void getConversationMessages({ data: { id: remoteId } })
      .then((rows) => {
        const stored = rows.map(toUIMessage)
        chat.setMessages(stored)
        if (last?.role === "user" && !stored.some((m) => m.id === last.id)) {
          runtime.thread.composer.setText(textOf(last))
        }
      })
      .catch(() => undefined)
  }
  const runtime = useAISDKRuntime(
    {
      ...chat,
      sendMessage: (message, options) => {
        chat.setMessages(cancelOvertaken)
        return chat.sendMessage(message, options)
      },
    },
    {
      cancelPendingToolCallsOnSend: false,
      suggestions,
      adapters: dictation ? { dictation } : {},
    }
  )
  return runtime
}
