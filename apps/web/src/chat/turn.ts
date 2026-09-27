import {
  ANSWER_TEXT_MAX,
  type ChatRequest,
  type ChatResult,
  ErrorEnvelope,
  TOOL_CALL_CANCELLED,
} from "@workspace/contracts"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai"

/** What the owner typed in a message. */
export const textOf = (message: UIMessage) =>
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
  messages: UIMessage[]
): ChatRequest {
  const last = messages.at(-1)
  if (last?.role === "user") {
    return {
      conversation_id: conversationId,
      mode,
      turn: { kind: "message", message_id: last.id, text: textOf(last) },
    }
  }
  // The server opens a new step after the calls it resolves, so the last
  // step holds only calls it is waiting on, and those resolved here are the
  // turn.
  const parts = last?.parts ?? []
  const step = parts.slice(
    parts.map((part) => part.type).lastIndexOf("step-start") + 1
  )
  const results = step.flatMap((part): ChatResult[] => {
    if (!isToolUIPart(part)) return []
    if (part.type === "tool-ask_fact" && part.state === "output-available") {
      return [
        {
          kind: "answer",
          tool_call_id: part.toolCallId,
          output: part.output as Extract<
            ChatResult,
            { kind: "answer" }
          >["output"],
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
  if (!last || results.length === 0) {
    throw new Error("There is nothing new in this conversation to send.")
  }
  return {
    conversation_id: conversationId,
    mode,
    turn: { kind: "results", message_id: last.id, results },
  }
}

/**
 * A typed message overtakes the calls still waiting on the owner, the way
 * `apps/api` cancels them in the stored row: an unanswered question or an
 * undecided change becomes cancelled, and anything the owner already
 * decided, a "not now" included, stays as it was. assistant-ui's own
 * `cancelPendingToolCallsOnSend` also turns a "not now" into cancelled,
 * which a reload would then contradict.
 */
export function cancelOvertaken(messages: UIMessage[]): UIMessage[] {
  const last = messages.at(-1)
  if (last?.role !== "assistant") return messages
  let changed = false
  const parts = last.parts.map((part) => {
    if (
      !isToolUIPart(part) ||
      (part.state !== "input-available" && part.state !== "approval-requested")
    ) {
      return part
    }
    changed = true
    const { approval: _, ...rest } = part
    return {
      ...rest,
      state: "output-error",
      errorText: TOOL_CALL_CANCELLED,
    } as UIMessage["parts"][number]
  })
  return changed ? [...messages.slice(0, -1), { ...last, parts }] : messages
}

/** Both kinds of answer send the turn on: a fact, and a yes or no. */
export const sendsOn = ({ messages }: { messages: UIMessage[] }) =>
  lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
  lastAssistantMessageIsCompleteWithApprovalResponses({ messages })

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
  const own = (body as { error?: unknown } | null)?.error
  throw new Error(
    typeof own === "string"
      ? own
      : `The assistant did not answer (${response.status}). Try again.`
  )
}
