import { useAui, useAuiState } from "@assistant-ui/react"
import { useLocation } from "@tanstack/react-router"
import { useEffect } from "react"
import { asked } from "./history"

/**
 * Sends a panel or page action's words as the owner's message in the
 * conversation on screen, once per press, after its history is in so the
 * message joins the thread rather than a placeholder.
 */
export function SendAsked({
  conversation,
}: {
  conversation: string | undefined
}) {
  const aui = useAui()
  const send = useLocation({ select: (location) => location.state.send })
  const ready = useAuiState(
    (s) =>
      !s.thread.isLoading &&
      (!conversation || s.threadListItem.remoteId === conversation)
  )
  useEffect(() => {
    if (!send || !ready || asked.has(send.key)) return
    asked.add(send.key)
    aui.thread().append(send.text)
  }, [send, ready, aui])
  return null
}
