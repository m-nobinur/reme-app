import {
  ANSWER_TEXT_MAX,
  type ChatRequest,
  type ChatResult,
  ErrorEnvelope,
  TOOL_CALL_CANCELLED,
} from "@workspace/contracts"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
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
 * message, or every answer to `ask_fact` and every yes or no on a tool in
 * the last step, as the SDK sends them together.
 */
export function chatTurn(
  conversationId: string,
  mode: ChatRequest["mode"],
  messages: ChatMessage[]
): ChatRequest {
  // The browser's zone, so the Chief of Staff can read "Friday at 9". The
  // reminder card names the same zone, from the same source.
  const time_zone = browserZone()
  const last = messages.at(-1)
  if (last?.role === "user") {
    return {
      conversation_id: conversationId,
      mode,
      time_zone,
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
 * What the owner resolved in the last step: an answer to `ask_fact`, and a
 * yes or no on any call. A call the server ran itself, such as a read, is
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
    if (part.type === "tool-ask_fact" && part.state === "output-available") {
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
 * Sends once the owner has answered every call in the last step that waits
 * on them, all in one turn. A step whose calls the server finished itself,
 * such as a read at the step limit, sends nothing.
 */
export const sendsOn = ({ messages }: { messages: ChatMessage[] }) =>
  ownerResults(messages.at(-1)).length > 0 &&
  (lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
    lastAssistantMessageIsCompleteWithApprovalResponses({ messages }))

/**
 * The transport's request body, which is the turn. It records the message
 * being sent before anything it awaits, so a send that fails at any point
 * restores this message, never one from an earlier send.
 */
export const turnBody =
  (
    initialize: () => Promise<{ remoteId: string }>,
    mode: () => ChatRequest["mode"],
    sending: { current: ChatMessage | undefined }
  ) =>
  async ({ messages }: { messages: ChatMessage[] }) => {
    sending.current = messages.at(-1)
    const { remoteId } = await initialize()
    return { body: chatTurn(remoteId, mode(), messages) }
  }

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
  if (envelope.success) throw new Error(envelope.data.message)
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
