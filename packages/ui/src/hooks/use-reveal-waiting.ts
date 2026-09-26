import {
  type ThreadViewportState,
  useAuiState,
  useThreadViewport,
} from "@assistant-ui/react"
import { useEffect } from "react"

/**
 * Brings a card that waits on the owner into view once no turn is running.
 * The thread anchors each turn at the top, so it does not follow a reply
 * that grows the last message (an answer continues it), and the new question
 * or the Approve button would otherwise sit under the composer. Pending cards
 * only ever sit at the end of the thread. Returns whether a turn is running.
 */
export function useRevealWaiting(waiting: boolean): boolean {
  const running = useAuiState((s) => s.thread.isRunning)
  const scrollToBottom = useThreadViewport({
    optional: true,
    selector: (s: ThreadViewportState) => s.scrollToBottom,
  })
  useEffect(() => {
    if (waiting && !running) scrollToBottom?.()
  }, [waiting, running, scrollToBottom])
  return running
}
