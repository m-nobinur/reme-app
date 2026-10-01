import type { ThreadReveal } from "@workspace/ui/components/assistant/thread"

/**
 * Onboarding's opening message plays in as a live reply once per browser:
 * the first time it is seen. After that, a reload, another tab or a return
 * shows it at once.
 */

const key = (messageId: string) => `reme:revealed:${messageId}`

/**
 * How recent an opening message has to be to play in when this browser
 * cannot say whether it has shown it: storage that throws, as a private
 * window or blocked site data can. Long enough to cover signup's redirects.
 */
export const FRESH_MS = 2 * 60 * 1000

/** Storage as far as this reads it, so a test can hand in its own. */
type Store = Pick<Storage, "getItem" | "setItem">

const local = (): Store => window.localStorage

export function revealer(
  store: () => Store = local,
  now: () => number = Date.now
): ThreadReveal {
  return {
    unseen: (messageId, createdAt) => {
      try {
        return store().getItem(key(messageId)) === null
      } catch {
        const at = createdAt ? Date.parse(createdAt) : Number.NaN
        return now() - at < FRESH_MS
      }
    },
    seen: (messageId) => {
      try {
        store().setItem(key(messageId), "1")
      } catch {
        // Nothing to keep it in; the age rule above stands in.
      }
    },
  }
}

/** This browser's, one object, so the thread's reveal never restarts on a render. */
export const OPENING_REVEAL = revealer()
