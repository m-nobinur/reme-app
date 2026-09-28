import type {
  MessageStorageEntry,
  RemoteThreadListAdapter,
  ThreadHistoryAdapter,
} from "@assistant-ui/react"
import type { Conversation, ConversationMessage } from "@workspace/contracts"
import type { UIMessage } from "ai"
import type { TransportedMessage } from "../lib/api/types"
import type { ChatMessage } from "./message"

/**
 * Stored conversations in assistant-ui's shapes: a row as the AI SDK
 * runtime's storage entry, a conversation as thread-list metadata, and the
 * history adapter that reads rows and never writes them.
 */

/**
 * The storage format `@assistant-ui/ai-sdk` 0.0.2 reads and writes. It
 * declares this type and the adapter but exports neither, so it is restated
 * here from its declaration: a `UIMessage` without its id.
 */
export type AISDKStorageFormat = Omit<UIMessage, "id">

/**
 * The format the contract pins, which is the one that adapter names. A
 * runtime that asks for any other is refused loudly rather than handed rows
 * it would misread.
 */
export const STORAGE_FORMAT: ConversationMessage["format"] = "ai-sdk/v6"

/**
 * A stored row in the adapter's storage shape. Every field is checked by
 * the compiler except the parts, which the contract keeps open and the AI
 * SDK types as its own union; they are the AI SDK's own parts, stored as it
 * wrote them.
 */
export function toStorageEntry(
  message: TransportedMessage
): MessageStorageEntry<AISDKStorageFormat> {
  const { parts, metadata, ...content } = message.content
  return {
    id: message.id,
    parent_id: message.parent_id,
    format: message.format,
    content: {
      ...content,
      // The owner's stored thumb, where assistant-ui reads a submitted one.
      metadata: message.feedback
        ? {
            ...metadata,
            submittedFeedback: {
              type: message.feedback === "up" ? "positive" : "negative",
            },
          }
        : metadata,
      parts: parts as unknown as UIMessage["parts"],
    },
  }
}

/**
 * A stored row as the AI SDK chat holds it: what `aiSDKV6FormatAdapter`
 * decodes it to on a history load, so a reload after a failed turn shows
 * the same thread a fresh load would.
 */
export const toUIMessage = (message: TransportedMessage): ChatMessage =>
  ({ id: message.id, ...toStorageEntry(message).content }) as ChatMessage

type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter["fetch"]>
>

/** A conversation as the thread list holds it. */
export const toMetadata = (
  conversation: Conversation
): RemoteThreadMetadata => ({
  remoteId: conversation.id,
  status: conversation.archived_at ? "archived" : "regular",
  title: conversation.title ?? undefined,
})

/**
 * The history of whichever thread is open, read once when it opens.
 * `remoteId` is read on each load, never captured, because the thread a
 * provider serves changes under it.
 */
export function conversationHistory(
  remoteId: () => string | undefined,
  read: (id: string) => Promise<TransportedMessage[]>
): ThreadHistoryAdapter {
  return {
    // The AI SDK runtime reads through `withFormat` only.
    load: async () => ({ messages: [] }),
    append: async () => undefined,
    withFormat: (format) => {
      if (format.format !== STORAGE_FORMAT) {
        throw new Error(
          `Stored conversations are ${STORAGE_FORMAT}; the runtime asked for ${format.format}.`
        )
      }
      return {
        load: async () => {
          const id = remoteId()
          if (!id) return { messages: [] }
          const messages = await read(id)
          return {
            messages: messages.map((message) =>
              format.decode(
                // The one storage format both sides name, checked above.
                toStorageEntry(message) as MessageStorageEntry<never>
              )
            ),
          }
        },
        // The server wrote the turn before the stream ended.
        append: async () => undefined,
      }
    },
  }
}

/**
 * Whether a navigation is a new "New chat" press. Only a new, defined state
 * is one: a replace navigation or a rail link carries none, and treating
 * that as a press would wipe a new chat's first send.
 */
export const startsNewChat = (
  previous: string | undefined,
  next: string | undefined
) => next !== undefined && next !== previous

/**
 * Conversations the owner opened by address and cannot have: another
 * account's, or an id that was never stored. The chat shows an empty state
 * for them rather than a thread nobody asked for.
 */
export const missingConversations = (() => {
  const ids = new Set<string>()
  const listeners = new Set<() => void>()
  return {
    has: (id: string) => ids.has(id),
    add(id: string) {
      ids.add(id)
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
})()
