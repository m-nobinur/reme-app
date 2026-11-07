import { SITTING_GAP_MS } from "@workspace/contracts"
import { useEffect, useState } from "react"

let atRegistrar = false

/**
 * The owner pressed a Buy from link: the next time this tab is hidden is
 * them going to the registrar, not another window covering the browser.
 */
export const followRegistrar = () => {
  atRegistrar = true
}

/**
 * Whether the owner is back from what they left the chat for, while
 * `waiting` holds: the tab shown again after it was hidden by following a
 * registrar link (`followRegistrar`), or a new sitting (`SITTING_GAP_MS`,
 * the journey's own, since their last message `lastSaidAt`). A return counts
 * only until they write again, so saying "I bought it" while still on the
 * page does not bring the question back. Forgotten once nothing waits.
 */
export function useBack(waiting: boolean, lastSaidAt: string | null) {
  const [returnedAfter, setReturnedAfter] = useState<{
    at: string | null
  } | null>(null)
  useEffect(() => {
    if (!waiting) {
      atRegistrar = false
      setReturnedAfter(null)
      return
    }
    let left = atRegistrar && document.visibilityState === "hidden"
    const onChange = () => {
      if (document.visibilityState === "hidden") left ||= atRegistrar
      else if (left) setReturnedAfter({ at: lastSaidAt })
    }
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [waiting, lastSaidAt])
  return (
    (returnedAfter !== null && returnedAfter.at === lastSaidAt) ||
    (waiting &&
      lastSaidAt !== null &&
      Date.now() - Date.parse(lastSaidAt) >= SITTING_GAP_MS)
  )
}
