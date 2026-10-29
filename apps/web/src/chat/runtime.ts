import { useChat } from "@ai-sdk/react"
import {
  type FeedbackAdapter,
  type ThreadSuggestion,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import { CARD_ANSWERED, type ChatRequest } from "@workspace/contracts"
import {
  clearOnboardingStatus,
  readOnboardingStatus,
} from "@workspace/ui/hooks/use-onboarding-status"
import { shownQuote } from "@workspace/ui/lib/quote-form"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState } from "react"
import { getConversationMessages, rateMessage } from "@/lib/api/server"
import { followThread, toUIMessage } from "./history"
import {
  IN_FLIGHT_MS,
  type InFlight,
  keepInFlight,
  readInFlight,
  setResuming,
} from "./in-flight"
import type { ChatMessage } from "./message"
import {
  cancelOvertaken,
  chatFetch,
  quoteChanges,
  replyTo,
  sendsOn,
  textOf,
  turnBody,
  withStoredCard,
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
  tail,
  refresh,
}: {
  onFinish: () => void
  /** Reads the panel's workspace now: a turn has written facts it shows. */
  refresh?: () => void
  suggestions: ThreadSuggestion[]
  /**
   * The composer's mode, read when the owner sends: that send carries it
   * and `onIntentSent` ends it. A ref, since this hook renders apart from
   * the page that holds the mode.
   */
  intent?: { current: ChatRequest["intent"] }
  onIntentSent?: () => void
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
  // The message of a turn a reload cut off, while its reply is awaited.
  const resumed = useRef<InFlight | null>(null)
  const thread = () => aui.threadListItem.getState().remoteId
  const settled = () => {
    const stored = thread()
    if (stored) keepInFlight(stored, null)
    if (resumed.current) {
      resumed.current = null
      setResuming(false)
    }
  }
  const prepare = turnBody(
    () => aui.threadListItem.initialize(),
    () => "act",
    sending
  )
  const [transport] = useState(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        fetch: chatFetch,
        // The whole body is the turn: no history, system prompt or tools
        // ever leave the browser. Always Act, which includes the reads: the
        // assistant works out whether a message asks or changes something.
        prepareSendMessagesRequest: async (options) => {
          const body = await prepare(options)
          const stored = thread()
          const last = sending.current
          if (stored && last?.role === "user") {
            keepInFlight(stored, {
              id: last.id,
              text: textOf(last),
              at: Date.now(),
            })
          }
          return body
        },
      })
  )
  // A failed turn leaves the screen ahead of the stored row: the answer or
  // the yes already shows, and nothing retries it. So the thread goes back
  // to exactly what is stored, with the card open again and the error
  // inline, and a typed message goes back into the composer. Through a ref,
  // because the chat keeps the first `onError` it is given.
  const restore = useRef<(error: Error) => void>(() => undefined)
  // The card a typed yes or no answered (`CARD_ANSWERED`): the thread showed
  // it cancelled when the message went, so its stored message is read again
  // when the stream names it and once more when the turn ends. A ref for the
  // same reason as `restore`.
  const answered = useRef<string | null>(null)
  const showAnswered = useRef<() => void>(() => undefined)
  const chat = useChat<ChatMessage>({
    id,
    transport,
    sendAutomaticallyWhen: sendsOn,
    onData: (part) => {
      if (readOnboardingStatus(part, () => refresh?.())) return
      if (part.type !== CARD_ANSWERED) return
      answered.current = (part.data as { tool_call_id: string }).tool_call_id
      showAnswered.current()
    },
    onFinish: () => {
      settled()
      clearOnboardingStatus()
      showAnswered.current()
      answered.current = null
      onFinish()
    },
    onError: (error) => {
      settled()
      clearOnboardingStatus()
      restore.current(error)
    },
  })
  // The owner's message carries the time it was sent, as a stored row does:
  // without it the thread shows the converter's clock, which moves on every
  // render. The api writes the same on its own new messages. A new turn
  // starts with no status, so the last turn's line never shows in it.
  const send: typeof chat.sendMessage = (message, options) => {
    clearOnboardingStatus()
    return chat.sendMessage(
      message && {
        ...message,
        metadata: {
          ...message.metadata,
          custom: { createdAt: new Date().toISOString() },
        },
      },
      options
    )
  }
  // The open thread's stored rows, or null when it is not stored yet.
  const storedRows = () => {
    const remoteId = aui.threadListItem.getState().remoteId
    return remoteId ? getConversationMessages({ data: { id: remoteId } }) : null
  }
  restore.current = (error) => {
    const last = sending.current
    // A reply to a card goes with it: the card is open again instead.
    // Words the owner typed, such as changes to a quote form, go back.
    const typed =
      last?.role === "user" && (!last.metadata?.reply || last.metadata.typed)
    const giveBack = () => {
      if (typed) runtime.thread.composer.setText(textOf(last))
    }
    // A session that ended can read nothing back; the error offers sign-in,
    // and the words wait in the composer, which this tab keeps.
    const read = error.message === SESSION_ENDED ? null : storedRows()
    if (!read) return giveBack()
    void read
      .then((rows) => {
        const stored = rows.map(toUIMessage)
        chat.setMessages(stored)
        if (!stored.some((m) => m.id === last?.id)) giveBack()
      })
      // Offline the rows cannot be read either; the words still go back.
      .catch(giveBack)
  }
  showAnswered.current = () => {
    const callId = answered.current
    const read = callId ? storedRows() : null
    if (!callId || !read) return
    void read
      .then((rows) =>
        chat.setMessages((messages) =>
          withStoredCard(messages, rows.map(toUIMessage), callId)
        )
      )
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
      apply: (rows) => {
        latest.current.setMessages(rows.map(toUIMessage))
        // A reply after the message a reload cut off: its turn is over.
        const at = rows.findIndex((row) => row.id === resumed.current?.id)
        if (at >= 0 && at < rows.length - 1) settled()
      },
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
    if (reply) await send(reply)
  }
  const runtime = useAISDKRuntime(
    {
      ...chat,
      addToolOutput,
      sendMessage: (message, options) => {
        const carried = intent?.current
        // Typed while a proposed quote form waits: the words answer it, and
        // go out as the owner's reply.
        const changes = quoteChanges(
          chat.messages,
          typedText(message),
          carried,
          (callId) => shownQuote.get(callId)
        )
        if (changes) return addToolOutput(changes)
        chat.setMessages(cancelOvertaken)
        if (!carried) return send(message, options)
        onIntentSent?.()
        return send(message, {
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
  // The composer's words, kept in this tab by stored thread, so a reload, a
  // lost connection or signing in again never loses them. Only a stored
  // thread: its id opens for its own org alone, where a new chat's key would
  // hand a draft to whoever signs in next in this tab.
  const remoteId = useAuiState((s) => s.threadListItem.remoteId)
  const composer = runtime.thread.composer
  useEffect(() => {
    if (!remoteId) return
    const key = `composer:${remoteId}`
    const store = (use: (storage: Storage) => void) => {
      try {
        use(window.sessionStorage)
      } catch {
        // Private windows and blocked site data throw; the words then last as long as the page.
      }
    }
    store((storage) => {
      const saved = storage.getItem(key)
      if (saved && !composer.getState().text) composer.setText(saved)
    })
    return composer.subscribe(() => {
      const { text } = composer.getState()
      store((storage) =>
        text ? storage.setItem(key, text) : storage.removeItem(key)
      )
    })
  }, [composer, remoteId])
  // After a reload, a turn still running shows its message and a working
  // line until the polled rows bring its reply; past its time, the words go
  // back to the composer.
  const loaded = chat.messages.length > 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided once, when the history is in
  useEffect(() => {
    if (!remoteId || !loaded || resumed.current || chat.status !== "ready")
      return
    const held = readInFlight(remoteId)
    if (!held || chat.messages.some((m) => m.id === held.id)) {
      keepInFlight(remoteId, null)
      return
    }
    resumed.current = held
    chat.setMessages((messages) => [
      ...messages,
      {
        id: held.id,
        role: "user",
        parts: [{ type: "text", text: held.text }],
        metadata: { custom: { createdAt: new Date(held.at).toISOString() } },
      },
    ])
    setResuming(true)
    const timer = setTimeout(
      () => {
        if (resumed.current !== held) return
        resumed.current = null
        setResuming(false)
        keepInFlight(remoteId, null)
        latest.current.setMessages((messages) =>
          messages.filter((m) => m.id !== held.id)
        )
        if (!composer.getState().text) composer.setText(held.text)
      },
      Math.max(0, held.at + IN_FLIGHT_MS - Date.now())
    )
    return () => clearTimeout(timer)
  }, [remoteId, loaded])
  return runtime
}
