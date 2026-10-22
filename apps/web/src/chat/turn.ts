import {
  ANSWER_TEXT_MAX,
  type ChatRequest,
  type ChatResult,
  ErrorEnvelope,
  ReviewQuoteFormOutput,
  TOOL_CALL_CANCELLED,
} from "@workspace/contracts"
import { factText } from "@workspace/ui/lib/facts"
import {
  choiceText,
  designText,
  detailsText,
  SESSION_ENDED,
  SKIPPED,
} from "@workspace/ui/lib/tool-state"
import { browserZone } from "@workspace/ui/lib/zone"
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai"
import type { ChatMessage } from "./message"

/** What the owner typed in a message. */
export const textOf = (message: ChatMessage) =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

/**
 * The one turn `/chat` reads, from the thread as the AI SDK holds it. The
 * server keeps the history, so only what the owner just did is sent: a typed
 * message, or every answer to an onboarding card and every yes or no on a tool in
 * the last step, as the SDK sends them together. `intent` goes with a typed
 * message only.
 */
export function chatTurn(
  conversationId: string,
  mode: ChatRequest["mode"],
  messages: ChatMessage[],
  intent?: ChatRequest["intent"]
): ChatRequest {
  // The browser's zone, so the Chief of Staff can read "Friday at 9". The
  // reminder card names the same zone, from the same source.
  const time_zone = browserZone()
  const last = messages.at(-1)
  // The owner's reply to a card goes with the answers of the message before it.
  if (last?.role === "user" && last.metadata?.reply) {
    const card = messages.at(-2)
    const results = ownerResults(card)
    if (!card || results.length === 0) {
      throw new Error("There is nothing new in this conversation to send.")
    }
    return {
      conversation_id: conversationId,
      mode,
      time_zone,
      turn: {
        kind: "results",
        message_id: card.id,
        results,
        reply: { message_id: last.id, text: textOf(last) },
      },
    }
  }
  if (last?.role === "user") {
    return {
      conversation_id: conversationId,
      mode,
      time_zone,
      ...(intent ? { intent } : {}),
      turn: { kind: "message", message_id: last.id, text: textOf(last) },
    }
  }
  const results = ownerResults(last)
  if (!last || results.length === 0) {
    throw new Error("There is nothing new in this conversation to send.")
  }
  return {
    conversation_id: conversationId,
    mode,
    time_zone,
    turn: { kind: "results", message_id: last.id, results },
  }
}

/**
 * What the owner resolved in the last step: an answer to an onboarding card
 * (`ask_open`, `ask_fact`, `ask_details`, `ask_choice`, `ask_design`, `ask_upload`,
 * `review_quote_form`), and a yes
 * or no on any call. A call the server ran itself, such as a read, is
 * not the owner's to send, even with its output in the step.
 */
function ownerResults(last: ChatMessage | undefined): ChatResult[] {
  // The server opens a new step after the calls it resolves, so an answer
  // in the last step is one it has not seen yet.
  const parts = last?.parts ?? []
  const step = parts.slice(
    parts.map((part) => part.type).lastIndexOf("step-start") + 1
  )
  return step.flatMap((part): ChatResult[] => {
    if (!isToolUIPart(part)) return []
    if (
      (part.type === "tool-ask_open" ||
        part.type === "tool-ask_fact" ||
        part.type === "tool-ask_details" ||
        part.type === "tool-ask_choice" ||
        part.type === "tool-ask_design" ||
        part.type === "tool-ask_upload" ||
        part.type === "tool-review_quote_form") &&
      part.state === "output-available"
    ) {
      return [
        {
          kind: "answer",
          tool_call_id: part.toolCallId,
          output: part.output,
        },
      ]
    }
    if (part.state === "approval-responded") {
      const { id, approved } = part.approval
      // The SDK takes any reason; the contract takes non-blank text up to
      // the answer cap, so one long or blank reason cannot fail the turn.
      const reason = part.approval.reason?.trim().slice(0, ANSWER_TEXT_MAX)
      return [
        {
          kind: "approval",
          approval_id: id,
          approved,
          ...(reason ? { reason } : {}),
        },
      ]
    }
    return []
  })
}

/**
 * `messages` with the message that holds `toolCallId` swapped for the stored
 * one. A typed yes or no that answered a card (`CARD_ANSWERED`) was shown as
 * cancelled when it was sent; the stored message has what the api did.
 */
export function withStoredCard(
  messages: ChatMessage[],
  stored: ChatMessage[],
  toolCallId: string
): ChatMessage[] {
  const fresh = stored.find((m) =>
    m.parts.some((p) => isToolUIPart(p) && p.toolCallId === toolCallId)
  )
  return fresh ? messages.map((m) => (m.id === fresh.id ? fresh : m)) : messages
}

/**
 * A typed message overtakes the calls still waiting on the owner, the way
 * `apps/api` cancels them in the stored row: an unanswered question or an
 * undecided change becomes cancelled. So does a yes or no held back while
 * another card in its step waited: it was never sent, so the stored row
 * still has the call undecided and the api cancels it. A decision the
 * server already has, a "not now" included, stays as it was.
 * assistant-ui's own `cancelPendingToolCallsOnSend` also turns that "not
 * now" into cancelled, which a reload would then contradict. A call still
 * streaming its input when the stream stopped is dropped: the api never
 * stores an unfinished call, so a reload does not show one either.
 */
export function cancelOvertaken(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1)
  if (last?.role !== "assistant") return messages
  let changed = false
  const parts = last.parts.flatMap((part): ChatMessage["parts"] => {
    if (isToolUIPart(part) && part.state === "input-streaming") {
      changed = true
      return []
    }
    if (
      !isToolUIPart(part) ||
      (part.state !== "input-available" &&
        part.state !== "approval-requested" &&
        part.state !== "approval-responded")
    ) {
      return [part]
    }
    changed = true
    const { approval: _, ...rest } = part
    const cancelled: ChatMessage["parts"][number] = {
      ...rest,
      state: "output-error",
      errorText: TOOL_CALL_CANCELLED,
    }
    return [cancelled]
  })
  return changed ? [...messages.slice(0, -1), { ...last, parts }] : messages
}

/**
 * A typed message while a proposed quote form waits is the owner's change to
 * it: the call it answers, as `{ answer: "changes", text }`, so the words
 * resolve the card rather than cancel it and the assistant reads them as
 * what to change. Null when no form waits, when the message carries a mode
 * of its own (a website change is not about the form), or when the words
 * do not fit an answer; such a message goes out as itself and overtakes the
 * card, as any typed message does.
 */
export function quoteChanges(
  messages: ChatMessage[],
  text: string,
  intent?: ChatRequest["intent"]
): {
  tool: "review_quote_form"
  toolCallId: string
  output: ReviewQuoteFormOutput
} | null {
  const last = messages.at(-1)
  if (intent || last?.role !== "assistant") return null
  const waiting = last.parts.find(
    (part) =>
      part.type === "tool-review_quote_form" && part.state === "input-available"
  )
  const output = ReviewQuoteFormOutput.safeParse({
    answer: "changes",
    text: text.trim(),
  })
  if (!waiting || !isToolUIPart(waiting) || !output.success) return null
  return {
    tool: "review_quote_form",
    toolCallId: waiting.toolCallId,
    output: output.data,
  }
}

/**
 * Sends once the owner has decided every call in the last step that waits
 * on them, all in one turn. A step whose calls the server finished itself,
 * such as a read at the step limit, sends nothing, and neither does an
 * answer to an onboarding card: `replyTo` sends that as the owner's reply.
 */
export const sendsOn = ({ messages }: { messages: ChatMessage[] }) => {
  const results = ownerResults(messages.at(-1))
  return (
    results.length > 0 &&
    results.every((result) => result.kind === "approval") &&
    (lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }))
  )
}

const CARDS = [
  "tool-ask_open",
  "tool-ask_fact",
  "tool-ask_details",
  "tool-ask_choice",
  "tool-ask_design",
  "tool-ask_upload",
  "tool-review_quote_form",
]

/**
 * An answered card as the owner's short reply: what they wrote, picked or
 * sent, never a sentence written for them. A skip reads Skipped, which the
 * thread shows muted.
 */
export function replyText(part: ChatMessage["parts"][number]): string | null {
  if (!isToolUIPart(part) || part.state !== "output-available") return null
  if (part.type === "tool-ask_open") {
    return part.output.answer === "stated" ? part.output.text : SKIPPED
  }
  if (part.type === "tool-ask_fact") {
    return part.output.answer === "stated"
      ? factText(part.output.fact.key, part.output.fact.value)
      : SKIPPED
  }
  if (part.type === "tool-ask_details") {
    return part.output.answer === "stated"
      ? detailsText(part.output.facts)
      : SKIPPED
  }
  if (part.type === "tool-ask_choice") {
    return part.output.answer === "chosen"
      ? choiceText(part.input, part.output)
      : SKIPPED
  }
  if (part.type === "tool-ask_design") {
    return designText(part.input, part.output)
  }
  if (part.type === "tool-ask_upload") {
    if (part.output.answer === "skipped") return SKIPPED
    const [only, ...more] = part.output.assets
    return more.length === 0 && only
      ? `Uploaded ${only.name}`
      : `Uploaded ${part.output.assets.length} photos`
  }
  if (part.type === "tool-review_quote_form") {
    return part.output.answer === "confirmed"
      ? "Use this form"
      : part.output.text
  }
  return null
}

/**
 * The owner's reply for an answer just given to a card in the last step,
 * once no other call in that step waits on them: the answers, in their
 * words, as a message of theirs. Null for any other output.
 */
export function replyTo(
  messages: ChatMessage[],
  given: { toolCallId: string; state?: string; output?: unknown }
): Omit<ChatMessage, "id"> | null {
  const last = messages.at(-1)
  if (last?.role !== "assistant" || given.state === "output-error") return null
  const parts = last.parts.map((part) =>
    isToolUIPart(part) && part.toolCallId === given.toolCallId
      ? ({
          ...part,
          state: "output-available",
          output: given.output,
        } as typeof part)
      : part
  )
  const step = parts.slice(
    parts.map((part) => part.type).lastIndexOf("step-start") + 1
  )
  const answered = step.find(
    (part) => isToolUIPart(part) && part.toolCallId === given.toolCallId
  )
  if (!answered || !CARDS.includes(answered.type)) return null
  if (
    step.some(
      (part) =>
        isToolUIPart(part) &&
        (part.state === "input-streaming" ||
          part.state === "input-available" ||
          part.state === "approval-requested")
    )
  ) {
    return null
  }
  const text = step.flatMap((part) => replyText(part) ?? []).join("\n")
  // Changes to a proposed quote form are words the owner typed.
  const typed =
    answered.type === "tool-review_quote_form" &&
    answered.state === "output-available" &&
    answered.output.answer === "changes"
  return {
    role: "user",
    parts: [{ type: "text", text }],
    metadata: typed ? { reply: true, typed: true } : { reply: true },
  }
}

/**
 * The transport's request body, which is the turn. It records the message
 * being sent before anything it awaits, so a send that fails at any point
 * restores this message, never one from an earlier send. `body.intent` is
 * what the owner's send carried, fixed when they pressed send.
 */
export const turnBody =
  (
    initialize: () => Promise<{ remoteId: string }>,
    mode: () => ChatRequest["mode"],
    sending: { current: ChatMessage | undefined }
  ) =>
  async ({
    messages,
    body,
  }: {
    messages: ChatMessage[]
    body?: { intent?: ChatRequest["intent"] } | undefined
  }) => {
    sending.current = messages.at(-1)
    const { remoteId } = await initialize()
    return { body: chatTurn(remoteId, mode(), messages, body?.intent) }
  }

/**
 * A session with no business behind it (`org.unresolved`), in the owner's
 * words: a first Google sign-in that skipped naming it, or a signup whose
 * business did not reach the session. The panel's first step names it.
 */
export const NO_BUSINESS =
  "Your account is not linked to a business yet. Name your business in the panel to get started."

/**
 * A refusal as the owner reads it: the api's envelope message, which it
 * writes for them, or the web route's own sentence, rather than the JSON the
 * AI SDK would otherwise show. The route's 401 is a session that ended, and
 * the thread offers sign-in for it.
 */
export async function chatFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(input, init)
  if (response.ok) return response
  const body: unknown = await response.json().catch(() => null)
  if (response.status === 401) throw new Error(SESSION_ENDED)
  const envelope = ErrorEnvelope.safeParse(body)
  if (envelope.success) {
    throw new Error(
      envelope.data.code === "org.unresolved"
        ? NO_BUSINESS
        : envelope.data.message
    )
  }
  const own =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : undefined
  throw new Error(
    typeof own === "string"
      ? own
      : `The assistant did not answer (${response.status}). Try again.`
  )
}
