import type { ChatRequest } from "@workspace/contracts"
import type { SaveDesignAnswer } from "@workspace/ui/components/assistant/ask-design"
import { chatFetch } from "./turn"

/**
 * The design tray's way to state an answer as the owner leaves its question:
 * the same results turn a finished tray sends, with only that answer in it.
 * The api states it as a fact and keeps the tray open, so a reload resumes
 * after it. It goes outside the AI SDK, which would read it as the tray
 * being answered.
 */
export const saveDesignAnswer: SaveDesignAnswer = async ({
  conversationId,
  messageId,
  toolCallId,
  output,
}) => {
  const body: ChatRequest = {
    conversation_id: conversationId,
    mode: "act",
    turn: {
      kind: "results",
      message_id: messageId,
      results: [{ kind: "answer", tool_call_id: toolCallId, output }],
    },
  }
  await chatFetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
