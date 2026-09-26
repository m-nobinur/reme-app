import { z } from "zod"
import { JsonObject, Timestamp, Uuid } from "./common.ts"

/** Text with something in it, as in `owner.ts`. */
const Text = (max: number) => z.string().min(1).max(max).regex(/\S/)

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
 * the stored content carries no metadata.
 */
export const ConversationMessage = z.strictObject({
  id: MessageId,
  parent_id: MessageId.nullable(),
  format: z.literal("ai-sdk/v6"),
  content: z.strictObject({
    role: z.enum(["user", "assistant"]),
    parts: z.array(JsonObject).min(1),
    metadata: z.strictObject({
      custom: z.strictObject({ createdAt: Timestamp }),
    }),
  }),
})

/** `GET /conversations/:id/messages`: oldest first, the whole conversation. */
export const ConversationHistory = z.strictObject({
  messages: z.array(ConversationMessage),
})

export type Conversation = z.infer<typeof Conversation>
export type ConversationList = z.infer<typeof ConversationList>
export type ConversationPatch = z.infer<typeof ConversationPatch>
export type ConversationMessage = z.infer<typeof ConversationMessage>
export type ConversationHistory = z.infer<typeof ConversationHistory>
