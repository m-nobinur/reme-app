import { useAui, useAuiState } from "@assistant-ui/react"
import { useLocation } from "@tanstack/react-router"
import type { ChatRequest } from "@workspace/contracts"
import { useEffect } from "react"
import { asked } from "./history"

/**
 * Sends a panel or page action's words as the owner's message in the
 * conversation on screen, once per press, after its history is in so the
 * message joins the thread rather than a placeholder. A Connect button's
 * intent goes into `intent`, which the send carries.
 */
export function SendAsked({
  conversation,
  intent,
}: {
  conversation: string | undefined
  intent: { current: ChatRequest["intent"] }
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
    if (send.intent) intent.current = send.intent
    aui.thread().append(send.text)
  }, [send, ready, aui, intent])
  return null
}
