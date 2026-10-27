import type { AnswerBuildQuestion } from "@workspace/ui/components/assistant/build-questions"
import { answerQuestion } from "@/lib/api/server"
import { attemptKeys } from "@/lib/attempt"

// The card sends one answer at a time, so one set of keys serves them all:
// a retry of the same answer is the same request.
const keys = attemptKeys()

/** The build question card's way to send an answer. */
export const answerBuildQuestion: AnswerBuildQuestion = async ({
  conversationId,
  reply,
}) => {
  const outcome = await answerQuestion({
    data: { conversationId, reply, key: keys.key(reply) },
  })
  if (!outcome.done) return outcome.reason
  keys.done()
  return "stack" in outcome ? outcome.stack : null
}
