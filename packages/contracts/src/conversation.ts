import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
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
 * https link in a new tab.
 */
export const ServerButton = z.strictObject({
  label: Text(60),
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ask"), text: Text(500) }),
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
 * A message the server posts on its own, with no owner turn: the text parts,
 * then the button part if there is one. `id` is derived from what happened,
 * not generated, so posting it twice stores it once.
 */
export const ServerMessage = z.strictObject({
  id: MessageId,
  text: z.array(Text(2000)).min(1).max(5),
  button: ServerButton.optional(),
})

/**
 * `GET /conversations/:id/messages`: oldest first, the whole conversation.
 * A response only, never a request body, as `ConversationMessage` says.
 */
export const ConversationHistory = z.strictObject({
  messages: z.array(ConversationMessage),
})

export type Conversation = z.infer<typeof Conversation>
export type ConversationList = z.infer<typeof ConversationList>
export type ConversationPatch = z.infer<typeof ConversationPatch>
export type ConversationMessage = z.infer<typeof ConversationMessage>
export type ConversationHistory = z.infer<typeof ConversationHistory>
export type MessageRating = z.infer<typeof MessageRating>
export type MessageFeedback = z.infer<typeof MessageFeedback>
export type ServerButton = z.infer<typeof ServerButton>
export type ServerButtonPart = z.infer<typeof ServerButtonPart>
export type ServerMessage = z.infer<typeof ServerMessage>
