import {
  type RemoteThreadListAdapter,
  RuntimeAdapterProvider,
  useAui,
} from "@assistant-ui/react"
import { titleText } from "@workspace/ui/lib/title"
import { type PropsWithChildren, useMemo } from "react"
import {
  createConversation,
  getConversation,
  getConversationMessages,
  listConversations,
  updateConversation,
} from "@/lib/api/server"
import {
  conversationHistory,
  missingConversations,
  toMetadata,
} from "./history"

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

/** Mounts the open thread's history for the runtime under it. */
function ConversationHistory({ children }: PropsWithChildren) {
  const aui = useAui()
  const history = useMemo(
    () =>
      conversationHistory(
        () => aui.threadListItem.getState().remoteId,
        (id) => getConversationMessages({ data: { id } })
      ),
    [aui]
  )
  return (
    <RuntimeAdapterProvider adapters={{ history }}>
      {children}
    </RuntimeAdapterProvider>
  )
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
    const found = await getConversation({ data: { id: threadId } })
    if (!found) {
      // The chat shows an empty state for it; the runtime stays on a new
      // thread underneath.
      missingConversations.add(threadId)
      throw new Error("That conversation is not one of yours.")
    }
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
  unstable_Provider: ConversationHistory,
}
