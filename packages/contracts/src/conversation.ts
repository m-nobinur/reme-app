import { z } from "zod"
import { JsonObject, Timestamp, Uuid } from "./common.ts"
import {
  ANSWER_TEXT_MAX,
  CHOICE_FACT_KEYS,
  FactValueKey,
  GOAL_MAX,
  OwnerAnswerText,
  REVIEW_FACT_KEYS,
} from "./owner.ts"
import { Hostname } from "./site.ts"
import { Text } from "./text.ts"

/**
 * A message id. The client's AI SDK makes user message ids with a
 * `generateId()` that cannot be configured, so this is text, not a UUID.
 */
const MessageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/**
 * One owner conversation. It is also the thread list's metadata: one shape
 * serves the list and a single fetch. The onboarding row is created by the
 * server; `POST /conversations` makes only `assistant` rows.
 */
export const Conversation = z.strictObject({
  id: Uuid,
  kind: z.enum(["onboarding", "assistant"]),
  /**
   * The owner's text. If it ever reaches a prompt, it goes in as quoted data,
   * never as instructions.
   */
  title: Text(120).nullable(),
  archived_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
})

/** `GET /conversations`: newest `updated_at` first, archived rows included. */
export const ConversationList = z.strictObject({
  conversations: z.array(Conversation).max(50),
})

/** `PATCH /conversations/:id`: a rename, or an archive or unarchive. One at a time. */
export const ConversationPatch = z.union([
  z.strictObject({ title: Text(120) }),
  z.strictObject({ archived: z.boolean() }),
])

/** An owner's thumb on an assistant message. */
export const MessageRating = z.enum(["up", "down"])

/**
 * `POST /conversations/:id/feedback`: the owner's rating of one assistant
 * message in the conversation. Each press sends its own Idempotency-Key, and
 * the latest recorded rating wins. No free text: the thumb is the whole of it.
 */
export const MessageFeedback = z.strictObject({
  message_id: MessageId,
  rating: MessageRating,
})

/**
 * One stored message in assistant-ui's `MessageStorageEntry` shape. `format`
 * is `aiSDKV6FormatAdapter.format`, which still says v6 on AI SDK 7.
 * `metadata.custom.createdAt` is written on read from the row's `created_at`;
 * the stored content carries no metadata. Each part names its `type`; the
 * rest of a part is the AI SDK's and stays open.
 *
 * A response shape only, never a request body. A route that takes messages
 * gets its own shape (role `user`, text parts only, capped); the server
 * writes assistant rows and `createdAt`.
 */
export const ConversationMessage = z.strictObject({
  id: MessageId,
  parent_id: MessageId.nullable(),
  format: z.literal("ai-sdk/v6"),
  content: z.strictObject({
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.looseObject({ type: z.string().min(1) })).min(1),
    metadata: z.strictObject({
      custom: z.strictObject({ createdAt: Timestamp }),
    }),
  }),
  /**
   * The owner's latest rating of an assistant message, read from its
   * `cos.feedback` events. Null for a user row and for one never rated.
   */
  feedback: MessageRating.nullable(),
})

/**
 * A button on a message the server posted. `ask` sends `text` as the owner's
 * next message, which the chat already does for a suggestion; `open` opens an
 * https link in a new tab; `pay` opens the details and Pay page for buying
 * `name`, which makes a fresh Checkout.
 */
export const ServerButton = z.strictObject({
  label: Text(60),
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ask"), text: Text(500) }),
    z.strictObject({ kind: z.literal("pay"), name: Hostname }),
    z.strictObject({
      kind: z.literal("open"),
      url: z
        .string()
        .max(2048)
        .regex(/^https:\/\/[^\s]+$/),
    }),
  ]),
})

/** How a `ServerButton` is stored among a message's parts: an AI SDK data part. */
export const ServerButtonPart = z.strictObject({
  type: z.literal("data-button"),
  data: ServerButton,
})

/**
 * A change the owner asked for in the panel, as it is stored among a message's
 * parts: an AI SDK data part, drawn as one resolved line.
 */
export const ChangeAsked = z.strictObject({ text: Text(GOAL_MAX) })
export const ChangeAskedPart = z.strictObject({
  type: z.literal("data-change_asked"),
  data: ChangeAsked,
})

/**
 * How the owner answers one question, as the web's `AnswerSpec`: a fact
 * key's own inputs, a closed list picked as written, or free text held to
 * a length and, for an address, the email rule.
 */
export const QuestionInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fact"),
    key: FactValueKey.exclude([...CHOICE_FACT_KEYS, ...REVIEW_FACT_KEYS]),
  }),
  z.strictObject({
    kind: z.literal("choice"),
    options: z.array(OwnerAnswerText).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal("text"),
    maxLength: z.int().min(1).max(ANSWER_TEXT_MAX),
    email: z.boolean(),
  }),
])

/** The owner's side of a question: their value (a fact key's value object, or text), or a skip. */
const OwnerQuestionAnswer = [
  z.strictObject({
    kind: z.literal("value"),
    value: z.union([OwnerAnswerText, JsonObject]),
  }),
  z.strictObject({ kind: z.literal("skipped") }),
] as const

/**
 * What became of one question: the owner's value or skip, or `closed` when
 * the build stopped waiting on it before the owner answered.
 */
export const QuestionAnswer = z.discriminatedUnion("kind", [
  ...OwnerQuestionAnswer,
  z.strictObject({ kind: z.literal("closed") }),
])

/**
 * One question the assistant puts to the owner for their website. `id` is
 * the build's request id for a build's question. `text` is the question in
 * the assistant's own words. `answer` is set once it is settled.
 */
export const BuildQuestion = z.strictObject({
  id: Uuid,
  text: Text(300),
  input: QuestionInput,
  skippable: z.boolean(),
  answer: QuestionAnswer.optional(),
  /** The fact an offer's answer is stored as. The server's only, never shown. */
  field: z.string().min(1).max(100).optional(),
})

const Questions = z.array(BuildQuestion).min(1).max(10)

/**
 * The questions one message asks, drawn as one stack. `build`: what a
 * build waits on, and an answer resumes it. `offer`: what a ready draft
 * left out; once every one is settled, the answers start one change on top
 * of that draft. `assignment_id` is the build's, read by the server only.
 * `address`: whether the owner has a web address (`ADDRESS_ASK`); it belongs
 * to the owner's address task, not to a build, so it names no assignment.
 */
export const BuildQuestions = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["build", "offer"]),
    assignment_id: Uuid,
    questions: Questions,
  }),
  z.strictObject({ kind: z.literal("address"), questions: Questions }),
])

/** How `BuildQuestions` is stored among a message's parts: an AI SDK data part. */
export const BuildQuestionsPart = z.strictObject({
  type: z.literal("data-build_questions"),
  data: BuildQuestions,
})

/**
 * `POST /conversations/{id}/questions`: the owner's answer to one question
 * of a stack, by the message that holds it. Answered with the
 * `BuildQuestions` as now stored.
 */
export const QuestionReply = z.strictObject({
  message_id: MessageId,
  question_id: Uuid,
  answer: z.discriminatedUnion("kind", [...OwnerQuestionAnswer]),
})

/**
 * A message the server posts on its own, with no owner turn: the text parts,
 * then the button part if there is one, then the questions if there are any.
 * `id` is derived from what happened, not generated, so posting it twice
 * stores it once.
 */
export const ServerMessage = z.strictObject({
  id: MessageId,
  text: z.array(Text(2000)).min(1).max(5),
  button: ServerButton.optional(),
  questions: BuildQuestions.optional(),
})

/**
 * `GET /conversations/:id/messages`: oldest first, the whole conversation.
 * A response only, never a request body, as `ConversationMessage` says.
 */
export const ConversationHistory = z.strictObject({
  messages: z.array(ConversationMessage),
})

export type Conversation = z.infer<typeof Conversation>
export type ChangeAsked = z.infer<typeof ChangeAsked>
export type ConversationList = z.infer<typeof ConversationList>
export type ConversationPatch = z.infer<typeof ConversationPatch>
export type ConversationMessage = z.infer<typeof ConversationMessage>
export type ConversationHistory = z.infer<typeof ConversationHistory>
export type MessageRating = z.infer<typeof MessageRating>
export type MessageFeedback = z.infer<typeof MessageFeedback>
export type ServerButton = z.infer<typeof ServerButton>
export type ServerButtonPart = z.infer<typeof ServerButtonPart>
export type ServerMessage = z.infer<typeof ServerMessage>
export type QuestionInput = z.infer<typeof QuestionInput>
export type QuestionAnswer = z.infer<typeof QuestionAnswer>
export type BuildQuestion = z.infer<typeof BuildQuestion>
export type BuildQuestions = z.infer<typeof BuildQuestions>
export type BuildQuestionsPart = z.infer<typeof BuildQuestionsPart>
export type QuestionReply = z.infer<typeof QuestionReply>
