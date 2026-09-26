import { type ChatRequest, ErrorEnvelope } from "@workspace/contracts"
import { CANCELLED } from "@workspace/ui/lib/tool-state"
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai"

/**
 * The one turn `/chat` reads, from the thread as the AI SDK holds it. The
 * server keeps the history, so only what the owner just did is sent: a typed
 * message, an answer to `ask_fact`, or a yes or no on `request_change`.
 */
export function chatTurn(
  conversationId: string,
  mode: ChatRequest["mode"],
  messages: UIMessage[]
): ChatRequest {
  const last = messages.at(-1)
  if (last?.role === "user") {
    const text = last.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    return {
      conversation_id: conversationId,
      mode,
      turn: { kind: "message", message_id: last.id, text },
    }
  }
  // The server opens a new step after every call it resolves, so the last
  // step holds only calls it is waiting on, and the one resolved here is
  // the turn.
  const parts = last?.parts ?? []
  const step = parts.slice(
    parts.map((part) => part.type).lastIndexOf("step-start") + 1
  )
  for (const part of step) {
    if (!last || !isToolUIPart(part)) continue
    if (part.type === "tool-ask_fact" && part.state === "output-available") {
      return {
        conversation_id: conversationId,
        mode,
        turn: {
          kind: "answer",
          message_id: last.id,
          tool_call_id: part.toolCallId,
          output: part.output as Extract<
            ChatRequest["turn"],
            { kind: "answer" }
          >["output"],
        },
      }
    }
    if (
      part.type === "tool-request_change" &&
      part.state === "approval-responded"
    ) {
      return {
        conversation_id: conversationId,
        mode,
        turn: {
          kind: "approval",
          message_id: last.id,
          approval_id: part.approval.id,
          approved: part.approval.approved,
        },
      }
    }
  }
  throw new Error("There is nothing new in this conversation to send.")
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
      errorText: CANCELLED,
    } as UIMessage["parts"][number]
  })
  return changed ? [...messages.slice(0, -1), { ...last, parts }] : messages
}

/** Both kinds of answer send the turn on: a fact, and a yes or no. */
export const sendsOn = ({ messages }: { messages: UIMessage[] }) =>
  lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
  lastAssistantMessageIsCompleteWithApprovalResponses({ messages })

/**
 * A refusal as the owner reads it: the envelope's own message, which the api
 * writes for them, rather than the JSON the AI SDK would otherwise show.
 */
export async function chatFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(input, init)
  if (response.ok) return response
  const envelope = ErrorEnvelope.safeParse(
    await response.json().catch(() => null)
  )
  throw new Error(
    envelope.success
      ? envelope.data.message
      : `The assistant did not answer (${response.status}). Try again.`
  )
}
