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
