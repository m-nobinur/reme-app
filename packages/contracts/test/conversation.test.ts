import { describe, expect, it } from "vitest"
import {
  BuildQuestionsPart,
  Conversation,
  ConversationList,
  ConversationMessage,
  ConversationPatch,
  MessageFeedback,
  QuestionReply,
} from "../src/conversation.ts"
import { ajv, generated } from "./json-schema.ts"
import { samples } from "./samples.ts"

// The refusals the round-trip fuzz is unlikely to hit, through Zod and the
// published JSON Schema both.

const verdict = (
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown
) => ({
  zod: schema.safeParse(value).success,
  json: ajv.validate(generated.components.schemas[name] as object, value),
})
const ACCEPTED = { zod: true, json: true }
const REFUSED = { zod: false, json: false }

const message = samples.ConversationMessage as {
  content: Record<string, unknown>
}
const conversation = samples.Conversation as Record<string, unknown>

describe("ConversationPatch", () => {
  it.each([
    ["a rename", { title: "Weekend prices" }],
    ["an archive", { archived: true }],
    ["an unarchive", { archived: false }],
  ])("accepts %s", (_name, patch) => {
    expect(verdict("ConversationPatch", ConversationPatch, patch)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["an empty patch", {}],
    ["a rename and an archive together", { title: "Prices", archived: true }],
    ["a 121-character title", { title: "a".repeat(121) }],
    ["a blank title", { title: "   " }],
  ])("refuses %s", (_name, patch) => {
    expect(verdict("ConversationPatch", ConversationPatch, patch)).toEqual(
      REFUSED
    )
  })
})

describe("Conversation", () => {
  it("takes a 120-character title and refuses 121", () => {
    const title = (n: number) => ({ ...conversation, title: "a".repeat(n) })
    expect(verdict("Conversation", Conversation, title(120))).toEqual(ACCEPTED)
    expect(verdict("Conversation", Conversation, title(121))).toEqual(REFUSED)
  })

  it("refuses a kind it does not know", () => {
    expect(
      verdict("Conversation", Conversation, {
        ...conversation,
        kind: "support",
      })
    ).toEqual(REFUSED)
  })
})

describe("ConversationList", () => {
  it("takes 50 conversations and refuses 51", () => {
    const list = (n: number) => ({
      conversations: Array.from({ length: n }, () => conversation),
    })
    expect(verdict("ConversationList", ConversationList, list(50))).toEqual(
      ACCEPTED
    )
    expect(verdict("ConversationList", ConversationList, list(51))).toEqual(
      REFUSED
    )
  })
})

describe("ConversationMessage", () => {
  it.each([
    ["a system message", { content: { ...message.content, role: "system" } }],
    ["a 65-character id", { id: "a".repeat(65) }],
    ["a 65-character parent id", { parent_id: "a".repeat(65) }],
    ["an id with a space", { id: "msg 1" }],
    ["a message with no parts", { content: { ...message.content, parts: [] } }],
    ["another storage format", { format: "aui/v0" }],
    [
      "a part with no type",
      { content: { ...message.content, parts: [{ text: "Hello" }] } },
    ],
    [
      "a part with an empty type",
      { content: { ...message.content, parts: [{ type: "", text: "Hello" }] } },
    ],
  ])("refuses %s", (_name, change) => {
    expect(
      verdict("ConversationMessage", ConversationMessage, {
        ...message,
        ...change,
      })
    ).toEqual(REFUSED)
  })

  it("takes a 64-character id", () => {
    expect(
      verdict("ConversationMessage", ConversationMessage, {
        ...message,
        id: "a".repeat(64),
      })
    ).toEqual(ACCEPTED)
  })
})

describe("MessageFeedback", () => {
  it.each([
    ["a thumb up", { message_id: "a_7Kd2Lm9Q", rating: "up" }],
    ["a thumb down", { message_id: "a_7Kd2Lm9Q", rating: "down" }],
  ])("accepts %s", (_name, feedback) => {
    expect(verdict("MessageFeedback", MessageFeedback, feedback)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["another rating", { message_id: "a_7Kd2Lm9Q", rating: "positive" }],
    ["no rating", { message_id: "a_7Kd2Lm9Q" }],
    ["a message id with a space", { message_id: "a 7", rating: "up" }],
    // No free text: the thumb is the whole of it.
    ["a note", { message_id: "a_7Kd2Lm9Q", rating: "up", note: "Wrong" }],
  ])("refuses %s", (_name, feedback) => {
    expect(verdict("MessageFeedback", MessageFeedback, feedback)).toEqual(
      REFUSED
    )
  })
})

describe("ConversationMessage feedback", () => {
  it.each([
    ["an unrated or user row", null],
    ["a thumb up", "up"],
    ["a thumb down", "down"],
  ])("accepts %s", (_name, feedback) => {
    expect(
      verdict("ConversationMessage", ConversationMessage, {
        ...(samples.ConversationMessage as object),
        feedback,
      })
    ).toEqual(ACCEPTED)
  })

  it("refuses a row that leaves feedback out, or rates it another way", () => {
    const { feedback: _, ...without } = samples.ConversationMessage as {
      feedback: unknown
    }
    expect(
      verdict("ConversationMessage", ConversationMessage, without)
    ).toEqual(REFUSED)
    expect(
      verdict("ConversationMessage", ConversationMessage, {
        ...without,
        feedback: "positive",
      })
    ).toEqual(REFUSED)
  })
})

describe("BuildQuestionsPart and QuestionReply", () => {
  const part = samples.BuildQuestionsPart as {
    data: { assignment_id: string; questions: Record<string, unknown>[] }
  }
  const asking = (patch: Record<string, unknown>) => ({
    ...part,
    data: {
      ...part.data,
      questions: [{ ...part.data.questions[1], ...patch }],
    },
  })

  it("refuses a fact input the owner picks rather than types", () => {
    const picked = asking({ input: { kind: "fact", key: "business.industry" } })
    expect(verdict("BuildQuestionsPart", BuildQuestionsPart, picked)).toEqual(
      REFUSED
    )
  })

  it("takes a question the server closed", () => {
    const closed = asking({ answer: { kind: "closed" } })
    expect(verdict("BuildQuestionsPart", BuildQuestionsPart, closed)).toEqual(
      ACCEPTED
    )
  })

  it("takes an address stack with no assignment and refuses one that names it", () => {
    const address = {
      ...part,
      data: { kind: "address", questions: part.data.questions },
    }
    expect(verdict("BuildQuestionsPart", BuildQuestionsPart, address)).toEqual(
      ACCEPTED
    )
    const named = {
      ...part,
      data: { ...address.data, assignment_id: part.data.assignment_id },
    }
    expect(verdict("BuildQuestionsPart", BuildQuestionsPart, named)).toEqual(
      REFUSED
    )
  })

  it("refuses a reply that closes a question: only the server does", () => {
    const reply = {
      ...(samples.QuestionReply as object),
      answer: { kind: "closed" },
    }
    expect(verdict("QuestionReply", QuestionReply, reply)).toEqual(REFUSED)
  })
})
