import { useAuiState, useThreadViewportStore } from "@assistant-ui/react"
import { type RefObject, useEffect, useRef, useState } from "react"

const REVEALING = '.aui-md[data-status="running"]'
const MESSAGE = '[data-slot="aui_assistant-message-content"]'

/**
 * Whether the words beside `mark` are still being revealed. The stream ends
 * before the reading pace has shown them all, so a card that waits only on
 * the stream would open under a sentence still being written.
 */
export function useWordsRevealing(
  mark: RefObject<HTMLElement | null>
): boolean {
  const [revealing, setRevealing] = useState(false)
  useEffect(() => {
    const content = mark.current?.closest(MESSAGE)
    if (!content) return
    const read = () => setRevealing(content.querySelector(REVEALING) !== null)
    read()
    const observer = new MutationObserver(read)
    observer.observe(content, {
      attributes: true,
      attributeFilter: ["data-status"],
      childList: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }, [mark])
  return revealing
}

/**
 * Brings a card that waits on the owner into view once no turn is running.
 * Pending cards only ever sit at the end of the thread. A card that opened
 * with the page is put in view at once, as the thread opens at its end. One
 * a turn brought stays where the turn left the view: a reply's first line
 * at the top, or wherever the owner scrolled to read. Only a turn no longer
 * anchored (something landed after it) glides to it. Returns whether a turn
 * is running, or `hold` says the words above it are still showing.
 */
export function useRevealWaiting(waiting: boolean, hold = false): boolean {
  const running = useAuiState((s) => s.thread.isRunning) || hold
  const viewport = useThreadViewportStore({ optional: true })
  const ran = useRef(running)
  useEffect(() => {
    if (running) ran.current = true
    else if (waiting) {
      const state = viewport?.getState()
      // A live turn sets the top anchor; a history that loads never does.
      if (state?.topAnchorTurn) return
      state?.scrollToBottom({ behavior: ran.current ? "smooth" : "instant" })
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
      if (composerIdle()) {
        card.current
          ?.querySelector<HTMLElement>("input")
          ?.focus({ preventScroll: true })
      }
    })
    return () => clearTimeout(timer)
  }, [running, waiting, card])
}

/** Focus is nowhere, or in an empty composer: the owner is not typing. */
export function composerIdle(): boolean {
  const held = document.activeElement
  return (
    !held ||
    held === document.body ||
    (held instanceof HTMLTextAreaElement && held.value === "")
  )
}
