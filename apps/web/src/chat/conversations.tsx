import { type RemoteThreadListAdapter, useAui } from "@assistant-ui/react"
import type { Conversation } from "@workspace/contracts"
import { titleText } from "@workspace/ui/lib/title"
import { useMemo } from "react"
import {
  createConversation,
  getConversation,
  getConversationMessages,
  listConversations,
  updateConversation,
} from "@/lib/api/server"
import type { TransportedMessage } from "@/lib/api/types"
import { conversationHistory, toMetadata } from "./history"

/**
 * Stored conversations behind assistant-ui's thread list. The server is the
 * only writer of messages: history is read here and never appended, so a
 * forged client history never reaches the model. Titles are the server's
 * too, set from the first message once the Chief of Staff writes them, and
 * nothing is deleted: there is no delete route until the retention promise
 * has an ADR.
 */

/** Threads a session with no organisation keeps in the tab, unstored. */
export const unstored = new Set<string>()

type Opening = { conversation: Conversation; messages: TransportedMessage[] }

/** What the /app loader read for the first page's conversation, each served once. */
const opening = new Map<string, Opening>()
const seeded = new WeakSet<Opening>()

export function seedOpening(held: Opening | null) {
  if (!held || seeded.has(held)) return
  seeded.add(held)
  opening.set(held.conversation.id, held)
}

/** A thread's stored rows: the loader's on its first read, else the server's. */
export async function readMessages(id: string) {
  const held = opening.get(id)
  opening.delete(id)
  return held?.messages ?? (await getConversationMessages({ data: { id } }))
}

/** The open thread's history for the runtime under it. */
function useConversationAdapters() {
  const aui = useAui()
  return useMemo(
    () => ({
      history: conversationHistory(
        () => aui.threadListItem.getState().remoteId,
        readMessages
      ),
    }),
    [aui]
  )
}

/**
 * A conversation the owner opened by address and cannot have: another
 * account's, or an id that was never stored. The thread list reports it as
 * its switch error, and the chat shows an empty state rather than a thread
 * nobody asked for.
 */
export class MissingConversation extends Error {
  constructor() {
    super("That conversation is not one of yours.")
  }
}

/** A title stream with nothing in it: the server names conversations. */
const NO_TITLE = () =>
  new ReadableStream<never>({
    start: (controller) => controller.close(),
  })

export const conversationList: RemoteThreadListAdapter = {
  list: async () => ({
    threads: (await listConversations()).map(toMetadata),
  }),
  // The local thread id is the idempotency key, so a retried first send
  // stores one conversation, not two. A session with no organisation has
  // nowhere to store it: the thread stays in this tab, under its local id.
  initialize: async (threadId) => {
    const stored = await createConversation({ data: { localId: threadId } })
    if (!stored) unstored.add(threadId)
    return { remoteId: stored?.id ?? threadId }
  },
  fetch: async (threadId) => {
    const found =
      opening.get(threadId)?.conversation ??
      (await getConversation({ data: { id: threadId } }))
    if (!found) throw new MissingConversation()
    return toMetadata(found)
  },
  rename: async (remoteId, title) => {
    // The same rule the top bar's form and the server apply.
    const kept = titleText(title)
    if (!kept) throw new Error("A title needs words.")
    await updateConversation({ data: { id: remoteId, title: kept } })
  },
  archive: async (remoteId) => {
    await updateConversation({ data: { id: remoteId, archived: true } })
  },
  unarchive: async (remoteId) => {
    await updateConversation({ data: { id: remoteId, archived: false } })
  },
  delete: async () => {
    throw new Error("Conversations are archived, never deleted.")
  },
  generateTitle: async () => NO_TITLE(),
  unstable_useAdapters: useConversationAdapters,
}
