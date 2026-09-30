import { useChat } from "@ai-sdk/react"
import {
  type FeedbackAdapter,
  type ThreadSuggestion,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import { DefaultChatTransport } from "ai"
import { useRef, useState } from "react"
import { getConversationMessages, rateMessage } from "@/lib/api/server"
import { toUIMessage } from "./history"
import type { ChatMessage } from "./message"
import { cancelOvertaken, chatFetch, sendsOn, textOf, turnBody } from "./turn"

/**
 * One stored conversation's runtime: the AI SDK chat under assistant-ui,
 * assembled here rather than through `useChatRuntime`, which in
 * @assistant-ui/react-ai-sdk 1.4.13 does not pass `cancelPendingToolCallsOnSend`
 * through. That option, left on, turns a "not now" into "cancelled" on the
 * owner's next message while the stored row keeps "not now", so a reload
 * disagreed with what the owner had just seen. `cancelOvertaken` cancels what
 * `apps/api` cancels and nothing else.
 */

export function useConversationRuntime({
  onFinish,
  suggestions,
}: {
  onFinish: () => void
  suggestions: ThreadSuggestion[]
}) {
  const aui = useAui()
  const id = useAuiState((s) => s.threadListItem.id)
  // The last message of the turn in flight, as the transport saw it. A turn
  // refused before the thread re-renders leaves `chat.messages` without it.
  const sending = useRef<ChatMessage | undefined>(undefined)
  const [transport] = useState(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        fetch: chatFetch,
        // The whole body is the turn: no history, system prompt or tools
        // ever leave the browser. Always Act, which includes the reads: the
        // assistant works out whether a message asks or changes something.
        prepareSendMessagesRequest: turnBody(
          () => aui.threadListItem.initialize(),
          () => "act",
          sending
        ),
      })
  )
  // A failed turn leaves the screen ahead of the stored row: the answer or
  // the yes already shows, and nothing retries it. So the thread goes back
  // to exactly what is stored, with the card open again and the error
  // inline, and a typed message goes back into the composer. Through a ref,
  // because the chat keeps the first `onError` it is given.
  const restore = useRef<(error: Error) => void>(() => undefined)
  const chat = useChat<ChatMessage>({
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
    const last = sending.current
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
  // The owner's thumb on a reply. It is kept on the chat's own message, so
  // the next update keeps it pressed, and sent with a key of this press's
  // own, so up, down, up records three ratings and a retry of one records
  // nothing. A rating that fails fails quietly: the api logs it, and the
  // adapter has no way to say so on the button.
  const feedback: FeedbackAdapter = {
    submit: ({ message, type }) => {
      const remoteId = aui.threadListItem.getState().remoteId
      if (!remoteId) return
      chat.setMessages((messages) =>
        messages.map((each) =>
          each.id === message.id
            ? {
                ...each,
                metadata: { ...each.metadata, submittedFeedback: { type } },
              }
            : each
        )
      )
      void rateMessage({
        data: {
          id: remoteId,
          message_id: message.id,
          rating: type === "positive" ? "up" : "down",
          key: crypto.randomUUID(),
        },
      }).catch(() => undefined)
    },
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
      adapters: { feedback },
    }
  )
  return runtime
}
