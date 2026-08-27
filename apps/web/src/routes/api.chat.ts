import { createFileRoute } from "@tanstack/react-router"
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  type UIMessage,
} from "ai"
import {
  APPROVED,
  DENIED,
  OPENING,
  type RecordedChunk,
} from "@/chat/recorded-conversation"

/**
 * Replays the recorded Chief of Staff conversation over the AI SDK v7 UI
 * message stream. The client cannot tell this apart from a live run: same SSE
 * framing, same chunk types, same order, and the approval genuinely blocks the
 * stream until the owner answers.
 *
 * `createUIMessageStreamResponse` rather than a `streamText(...)
 * .toUIMessageStreamResponse()` call, which is what the plan names. Both emit
 * the same wire format, but `toUIMessageStreamResponse` only exists on a
 * `streamText` result, so reaching it would mean putting a mock language model
 * in the production worker to feed it. Replaying recorded chunks is what a
 * recorded fixture is.
 */

/** The owner's answer to the pending approval, or undefined on the first turn. */
function approvalAnswer(messages: UIMessage[]): boolean | undefined {
  const last = messages.at(-1)
  if (last?.role !== "assistant") return undefined

  for (const part of last.parts) {
    if (!isToolUIPart(part)) continue
    if (part.state === "approval-responded") return part.approval.approved
    if (part.state === "output-denied") return false
  }
  return undefined
}

async function replay(
  chunks: RecordedChunk[],
  writer: { write: (chunk: RecordedChunk["chunk"]) => void },
  messageId: string | undefined
) {
  for (const { delayMs, chunk } of chunks) {
    if (chunk.type === "start" && messageId) {
      writer.write({ ...chunk, messageId })
      continue
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    writer.write(chunk)
  }
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { messages } = (await request.json()) as {
          messages: UIMessage[]
        }
        const answer = approvalAnswer(messages)
        const chunks =
          answer === undefined ? OPENING : answer ? APPROVED : DENIED
        // Continuing the message the owner answered on, rather than opening a
        // second one: a `start` with a new id makes the client render the turn
        // twice.
        const messageId = answer === undefined ? undefined : messages.at(-1)?.id

        return createUIMessageStreamResponse({
          stream: createUIMessageStream({
            execute: ({ writer }) => replay(chunks, writer, messageId),
          }),
        })
      },
    },
  },
})
