import {
  ADDRESS_ASK,
  type BuildQuestion,
  type BuildQuestions,
  type QuestionAnswer,
  type QuestionReply,
} from "@workspace/contracts"
import {
  addressSaid,
  nextOpen,
} from "@workspace/ui/components/assistant/build-questions"
import { expect, it, vi } from "vitest"

const server = vi.hoisted(() => ({
  answerQuestion: vi.fn<
    () => Promise<
      { done: true; stack?: BuildQuestions } | { done: false; reason: string }
    >
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

it("hands the card the stack as stored, so a closed question is not asked", async () => {
  const stack: BuildQuestions = {
    kind: "address",
    questions: [question("a", true), question("b", true)],
  }
  server.answerQuestion.mockResolvedValueOnce({ done: true, stack })
  expect(
    await answerBuildQuestion({ conversationId: "c", reply: reply("No") })
  ).toEqual(stack)
})

it("says the address answer as the owner's message, and nothing for Not now", () => {
  const have = {
    id: "00000000-0000-4000-8000-000000000001",
    text: ADDRESS_ASK.have,
    input: { kind: "choice", options: [ADDRESS_ASK.yes] },
    skippable: false,
  } as BuildQuestion
  const name = {
    id: "00000000-0000-4000-8000-000000000002",
    text: ADDRESS_ASK.name,
    input: { kind: "text", maxLength: 253, email: false },
    skippable: true,
  } as BuildQuestion
  const said = (choice: string, named: QuestionAnswer) =>
    addressSaid([have, name], (each) =>
      each === have ? { kind: "value", value: choice } : named
    )
  expect(said(ADDRESS_ASK.yes, { kind: "value", value: "sparkle.co.uk" })).toBe(
    "Yes, it's sparkle.co.uk"
  )
  expect(said(ADDRESS_ASK.yes, { kind: "skipped" })).toBe(
    "Yes, I have a web address"
  )
  expect(said(ADDRESS_ASK.no, { kind: "closed" })).toBe(ADDRESS_ASK.no)
  expect(said(ADDRESS_ASK.later, { kind: "closed" })).toBeNull()
})
