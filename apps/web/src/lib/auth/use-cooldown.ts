import { useCallback, useEffect, useState } from "react"

export const RESEND_COOLDOWN_SECONDS = 60

// Session storage, so a refresh does not hand out a fresh countdown. It is a
// courtesy to the user, not the limit: `resendVerification` throttles on the
// server.
function readDeadline(key: string): number | null {
  try {
    const saved = Number(window.sessionStorage.getItem(key))
    return saved > 0 ? saved : null
  } catch {
    return null
  }
}

function saveDeadline(key: string, deadline: number) {
  try {
    window.sessionStorage.setItem(key, String(deadline))
  } catch {
    // Storage blocked: the countdown still runs, it just resets on refresh.
  }
}

/**
 * The wait before a code can be sent again. It starts when the page opens,
 * because the page is only reached right after a code was sent, and `start`
 * restarts it after each resend.
 *
 * Counts down to a deadline rather than by decrementing, so a throttled
 * background tab shows the right number when it wakes. Before the effect runs
 * it reports the full wait, so the server render and the first client render
 * agree and the button never flashes enabled.
 */
export function useCooldown(storageKey: string) {
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(0)

  const start = useCallback(() => {
    const next = Date.now() + RESEND_COOLDOWN_SECONDS * 1000
    saveDeadline(storageKey, next)
    setNow(Date.now())
    setDeadline(next)
  }, [storageKey])

  useEffect(() => {
    const saved = readDeadline(storageKey)
    if (saved === null) {
      start()
    } else {
      setNow(Date.now())
      setDeadline(saved)
    }
  }, [storageKey, start])

  useEffect(() => {
    if (deadline === null || deadline <= Date.now()) {
      return
    }
    const id = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= deadline) {
        clearInterval(id)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [deadline])

  const secondsLeft =
    deadline === null
      ? RESEND_COOLDOWN_SECONDS
      : Math.max(0, Math.ceil((deadline - now) / 1000))

  return { secondsLeft, start }
}
