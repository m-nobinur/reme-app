import type { BuildQuestion, QuestionReply } from "@workspace/contracts"
import { nextOpen } from "@workspace/ui/components/assistant/build-questions"
import { expect, it, vi } from "vitest"

const server = vi.hoisted(() => ({
  answerQuestion: vi.fn<
    () => Promise<{ done: true } | { done: false; reason: string }>
  >(async () => ({ done: true })),
}))
vi.mock("@/lib/api/server", () => server)

const { answerBuildQuestion } = await import("./build-questions")

const question = (id: string, settled = false) =>
  ({
    id,
    text: "When are you open?",
    input: { kind: "fact", key: "hours.weekday" },
    skippable: false,
    ...(settled ? { answer: { kind: "skipped" } } : {}),
  }) as BuildQuestion

it("moves on to the next open question, then back to one passed over", () => {
  const stack = [question("a"), question("b", true), question("c")]
  const settled = (each: BuildQuestion) => Boolean(each.answer)
  expect(nextOpen(stack, settled, 0)).toBe(2)
  expect(nextOpen(stack, settled, 2)).toBe(0)
  expect(nextOpen([question("a"), question("b", true)], settled, 0)).toBe(
    undefined
  )
})

const reply = (value: string): QuestionReply => ({
  message_id: "msg-1",
  question_id: "00000000-0000-4000-8000-000000000006",
  answer: { kind: "value", value },
})

it("sends a retry of the same answer as the same request, and says a refusal", async () => {
  const send = (value: string) =>
    answerBuildQuestion({ conversationId: "c", reply: reply(value) })
  const keyOf = (call: number) =>
    (
      server.answerQuestion.mock.calls[call] as unknown as [
        { data: { key: string } },
      ]
    )[0].data.key

  server.answerQuestion.mockResolvedValueOnce({
    done: false,
    reason: "Try again.",
  })
  expect(await send("Yes")).toBe("Try again.")
  expect(await send("Yes")).toBeNull()
  expect(keyOf(1)).toBe(keyOf(0))
  // Stored: the next answer is a new request.
  await send("Yes")
  expect(keyOf(2)).not.toBe(keyOf(1))
})
