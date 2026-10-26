import { useAuiState, useThreadViewportStore } from "@assistant-ui/react"
import { type RefObject, useEffect, useRef } from "react"

/**
 * Brings a card that waits on the owner into view once no turn is running.
 * The thread anchors each turn at the top, so it does not follow a reply
 * that grows the last message (an answer continues it), and the new question
 * or the Approve button would otherwise sit under the composer. Pending cards
 * only ever sit at the end of the thread. A card that opened with the page
 * is put in view at once, as the thread opens at its end; one a turn brought
 * glides in, even when it lands in the same render the turn ends. Returns
 * whether a turn is running.
 */
export function useRevealWaiting(waiting: boolean): boolean {
  const running = useAuiState((s) => s.thread.isRunning)
  const viewport = useThreadViewportStore({ optional: true })
  const ran = useRef(running)
  useEffect(() => {
    if (running) ran.current = true
    else if (waiting) {
      const state = viewport?.getState()
      // A live turn sets the top anchor; a history that loads never does.
      const live = ran.current || Boolean(state?.topAnchorTurn)
      state?.scrollToBottom({ behavior: live ? "smooth" : "instant" })
    }
  }, [waiting, running, viewport])
  return running
}

/**
 * Gives an open card the focus once no turn is running, so the answer goes
 * straight in and Enter cannot send the composer's text over it. Only from
 * nowhere or an empty composer, never from something the owner is typing.
 * Deferred a task, because the composer refocuses itself when a run ends.
 */
export function useFocusWhenIdle(
  waiting: boolean,
  running: boolean,
  card: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (running || !waiting) return
    const timer = setTimeout(() => {
      const held = document.activeElement
      const idle =
        !held ||
        held === document.body ||
        (held instanceof HTMLTextAreaElement && held.value === "")
      if (idle) {
        card.current
          ?.querySelector<HTMLElement>("input")
          ?.focus({ preventScroll: true })
      }
    })
    return () => clearTimeout(timer)
  }, [running, waiting, card])
}
