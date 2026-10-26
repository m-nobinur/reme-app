import { CHAT_TURN_MS } from "@workspace/contracts"
import { useSyncExternalStore } from "react"

/**
 * The owner's message a turn is carrying, kept per stored thread, so a reload
 * mid-turn still shows it and gives the words back if no reply lands.
 */

export type InFlight = { id: string; text: string; at: number }

/** How long a turn may run before a reload stops waiting for its reply. */
export const IN_FLIGHT_MS = CHAT_TURN_MS + 15_000

const key = (thread: string) => `turn:${thread}`

const store = <R>(use: (storage: Storage) => R): R | null => {
  try {
    return use(window.sessionStorage)
  } catch {
    return null
  }
}

export function keepInFlight(thread: string, message: InFlight | null) {
  store((storage) =>
    message
      ? storage.setItem(key(thread), JSON.stringify(message))
      : storage.removeItem(key(thread))
  )
}

export function readInFlight(
  thread: string,
  now = Date.now()
): InFlight | null {
  const saved = store((storage) => storage.getItem(key(thread)))
  if (!saved) return null
  const message = JSON.parse(saved) as InFlight
  return now - message.at < IN_FLIGHT_MS ? message : null
}

// Whether the thread is waiting on a turn a reload cut off, for its line.
let resuming = false
const listeners = new Set<() => void>()

export function setResuming(on: boolean) {
  resuming = on
  for (const listener of listeners) listener()
}

export const useResuming = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => resuming,
    () => false
  )
