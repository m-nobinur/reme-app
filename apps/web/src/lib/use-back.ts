import { SITTING_GAP_MS } from "@workspace/contracts"
import { useEffect, useState } from "react"

/**
 * Whether the owner is back from what they left the chat for, while
 * `waiting` holds: the tab shown again after it was hidden, or a new
 * sitting (`SITTING_GAP_MS`, the journey's own, since their last message
 * `lastSaidAt`). Forgotten once nothing waits.
 */
export function useBack(waiting: boolean, lastSaidAt: string | null) {
  const [returned, setReturned] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setReturned(false)
      return
    }
    let left = document.visibilityState === "hidden"
    const onChange = () => {
      if (document.visibilityState === "hidden") left = true
      else if (left) setReturned(true)
    }
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [waiting])
  return (
    returned ||
    (waiting &&
      lastSaidAt !== null &&
      Date.now() - Date.parse(lastSaidAt) >= SITTING_GAP_MS)
  )
}
