import { useAuiState } from "@assistant-ui/react"
import type {
  ThreadComponents,
  ThreadProps,
  ThreadReveal,
} from "@workspace/ui/components/assistant/thread"
import { createContext, useContext } from "react"

type ThreadSettings = Omit<
  ThreadProps,
  "components" | "autoFocus" | "after" | "updates" | "reveal" | "lastShown"
>

export const EMPTY_COMPONENTS: ThreadComponents = {}
const EMPTY_SETTINGS: ThreadSettings = {}

export const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS)
export const ThreadSettingsContext =
  createContext<ThreadSettings>(EMPTY_SETTINGS)
// Apart from the settings, which every message would otherwise re-render on:
// a new mode or briefing then redrew the whole transcript.
export const ThreadRevealContext = createContext<ThreadReveal | undefined>(
  undefined
)
// The first message the owner has not seen here, which the "New" rule sits above.
export const NewSinceContext = createContext<string | null>(null)

/**
 * Whether the composer can send. A stored conversation opens on a placeholder
 * thread and swaps to the stored one once it is fetched; a send before then
 * went to the placeholder and started a second conversation. So nothing sends
 * until the main thread is the stored conversation and its history is in.
 * The thread's id decides, not the loading flags alone: the placeholder's
 * read false.
 */
export const useSendable = () => {
  const { stored } = useContext(ThreadSettingsContext)
  return useAuiState(
    (s) =>
      !stored || (s.threadListItem.remoteId === stored && !s.thread.isLoading)
  )
}
