import { ONBOARDING_STATUS, OnboardingStatus } from "@workspace/contracts"
import {
  LATE_AFTER,
  STILL_AFTER,
  WORKING_AFTER,
} from "@workspace/ui/lib/activity-copy"
import { useEffect, useState, useSyncExternalStore } from "react"

/**
 * What the turn in flight is on, from its `ONBOARDING_STATUS` parts, for the
 * waiting line: the onboarding planner's step or line, or the heading of the
 * thought the model is on in any chat. One chat streams at a time, so one
 * value for the page; null between turns.
 */
let latest: OnboardingStatus["on"] | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const set = (on: OnboardingStatus["on"] | null) => {
  latest = on
  for (const listener of listeners) listener()
}

/** The turn has ended: the next one starts with no status. */
export const clearOnboardingStatus = () => set(null)

/**
 * Reads a stream's data part, and says whether it was a status. A status
 * becomes the waiting line, unless the planner's own line for the turn
 * already is, and one that names facts calls `refresh`: the
 * api wrote them before sending it, so the panel can tick them at once.
 */
export function readOnboardingStatus(
  part: { type: string; data?: unknown },
  refresh: () => void
): boolean {
  if (part.type !== ONBOARDING_STATUS) return false
  const status = OnboardingStatus.safeParse(part.data)
  if (!status.success) return true
  // The planner's own line for the turn stands; the stock lines after it
  // would only read as a step back.
  if (latest?.kind !== "doing") set(status.data.on)
  if (status.data.facts.length > 0) refresh()
  return true
}

/** The latest status of the turn in flight, or null. */
export const useOnboardingStatus = () =>
  useSyncExternalStore(
    subscribe,
    () => latest,
    () => null
  )

const MARKS = [WORKING_AFTER, STILL_AFTER, LATE_AFTER]

/**
 * The latest status and the seconds it has stood, in steps at the waiting
 * line's marks: news starts the count again.
 */
export function useOnboardingWait() {
  const status = useOnboardingStatus()
  const [stood, setStood] = useState({ status, seconds: 0 })
  useEffect(() => {
    const timers = MARKS.map((at) =>
      setTimeout(() => setStood({ status, seconds: at }), at * 1000)
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [status])
  return { status, seconds: stood.status === status ? stood.seconds : 0 }
}
