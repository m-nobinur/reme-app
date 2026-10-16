import { useChat } from "@ai-sdk/react"
import {
  type FeedbackAdapter,
  type ThreadSuggestion,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { ChatRequest } from "@workspace/contracts"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState } from "react"
import { getConversationMessages, rateMessage } from "@/lib/api/server"
import { planNote } from "./blueprint-plan"
import { followThread, toUIMessage } from "./history"
import type { ChatMessage } from "./message"
import {
  blueprintChanges,
  cancelOvertaken,
  chatFetch,
  quoteChanges,
  replyTo,
  sendsOn,
  textOf,
  turnBody,
} from "./turn"

/**
 * One stored conversation's runtime: the AI SDK chat under assistant-ui,
 * assembled here rather than through `useChatRuntime`, which in
 * @assistant-ui/react-ai-sdk 1.4.13 does not pass `cancelPendingToolCallsOnSend`
 * through. That option, left on, turns a "not now" into "cancelled" on the
 * owner's next message while the stored row keeps "not now", so a reload
 * disagreed with what the owner had just seen. `cancelOvertaken` cancels what
 * `apps/api` cancels and nothing else.
 */

/** The words of a message the composer sends. */
function typedText(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  if ("text" in message && typeof message.text === "string") return message.text
  const parts =
    "parts" in message && Array.isArray(message.parts) ? message.parts : []
  return parts
    .flatMap((part: { type?: string; text?: string }) =>
      part.type === "text" && part.text ? [part.text] : []
    )
    .join("\n")
}

export function useConversationRuntime({
  onFinish,
  suggestions,
  intent,
  onIntentSent,
  planChange,
  tail,
}: {
  onFinish: () => void
  suggestions: ThreadSuggestion[]
  /**
   * The composer's mode, read when the owner sends: that send carries it
   * and `onIntentSent` ends it. A ref, since this hook renders apart from
   * the page that holds the mode.
   */
  intent?: { current: ChatRequest["intent"] }
  onIntentSent?: () => void
  /**
   * Set while a Blueprint card waits (blueprint-plan.tsx): a message that
   * finishes its "Change something" goes there as the owner's note, not to
   * the chat. A ref for the same reason as `intent`.
   */
  planChange?: { current: ((note: string) => Promise<boolean>) | null }
  /**
   * The polled `/workspace` tag's tail (`tailOf`), kept by the page: this
   * hook renders apart from it and never sees the workspace change, so the
   * page calls `moved` when the tail does.
   */
  tail?: { current: string | null; moved?: () => void }
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
  // The open thread's stored rows, or null when it is not stored yet.
  const storedRows = () => {
    const remoteId = aui.threadListItem.getState().remoteId
    return remoteId ? getConversationMessages({ data: { id: remoteId } }) : null
  }
  restore.current = (error) => {
    // A session that ended can read nothing back; the error offers sign-in.
    const read = error.message === SESSION_ENDED ? null : storedRows()
    if (!read) return
    const last = sending.current
    void read
      .then((rows) => {
        const stored = rows.map(toUIMessage)
        chat.setMessages(stored)
        // A reply to a card goes with it: the card is open again instead.
        // Words the owner typed, such as changes to a quote form, go back.
        if (
          last?.role === "user" &&
          (!last.metadata?.reply || last.metadata.typed) &&
          !stored.some((m) => m.id === last.id)
        ) {
          runtime.thread.composer.setText(textOf(last))
        }
      })
      .catch(() => undefined)
  }
  // A message the assistant posted on its own: the polled tag names it, and
  // the thread reads its rows again between turns. Through a ref, because a
  // read lands after the render that started it.
  const latest = useRef(chat)
  latest.current = chat
  const [follow] = useState(() =>
    followThread({
      read: async () => storedRows(),
      now: () => ({
        idle: ["ready", "error"].includes(latest.current.status),
        messages: latest.current.messages,
      }),
      apply: (rows) => latest.current.setMessages(rows.map(toUIMessage)),
    })
  )
  useEffect(() => {
    if (!tail) return
    tail.moved = () => void follow(tail.current)
    return () => {
      tail.moved = undefined
    }
  }, [follow, tail])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a turn ending is a time to read a tail it held back.
  useEffect(() => {
    void follow(tail?.current ?? null)
  }, [follow, chat.status])
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
  // An answer to an onboarding card goes out as the owner's reply, so the
  // answer reads as theirs and the next step is a message of its own.
  const addToolOutput = async (
    given: Parameters<typeof chat.addToolOutput>[0]
  ) => {
    const reply = replyTo(chat.messages, given)
    await chat.addToolOutput(given)
    if (reply) await chat.sendMessage(reply)
  }
  const runtime = useAISDKRuntime(
    {
      ...chat,
      addToolOutput,
      sendMessage: (message, options) => {
        const carried = intent?.current
        // Typed while a proposed quote form or a plan waits: the words answer
        // it, and go out as the owner's reply.
        const text = typedText(message)
        const changes =
          quoteChanges(chat.messages, text, carried) ??
          blueprintChanges(chat.messages, text, carried)
        if (changes) return addToolOutput(changes)
        const note = carried ? null : planNote(text)
        const decide = planChange?.current
        if (note !== null && decide) {
          // A refused note goes back into the composer, as a failed turn's words do.
          return decide(note).then((done) => {
            if (!done) runtime.thread.composer.setText(text)
          })
        }
        chat.setMessages(cancelOvertaken)
        if (!carried) return chat.sendMessage(message, options)
        onIntentSent?.()
        return chat.sendMessage(message, {
          ...options,
          body: { ...options?.body, intent: carried },
        })
      },
    },
    {
      cancelPendingToolCallsOnSend: false,
      // A turn is one stored row that grows, and an owner row separates
      // turns, so two assistant rows in a row are never one reply: a message
      // the assistant posted on its own is a message of its own.
      joinStrategy: "none",
      suggestions,
      adapters: { feedback },
    }
  )
  return runtime
}
