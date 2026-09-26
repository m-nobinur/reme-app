import { useChat } from "@ai-sdk/react"
import {
  type DictationAdapter,
  type ThreadSuggestion,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { ChatRequest } from "@workspace/contracts"
import { DefaultChatTransport } from "ai"
import { useState } from "react"
import { cancelOvertaken, chatFetch, chatTurn, sendsOn } from "./turn"

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
  const chat = useChat({
    id,
    transport,
    sendAutomaticallyWhen: sendsOn,
    onFinish,
  })
  return useAISDKRuntime(
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
}
