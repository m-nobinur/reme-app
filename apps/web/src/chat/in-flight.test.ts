import { afterEach, expect, it, vi } from "vitest"
import { IN_FLIGHT_MS, keepInFlight, readInFlight } from "./in-flight"

afterEach(() => vi.unstubAllGlobals())

it("keeps the message a turn carries until it ends, and only while it may still land", () => {
  const saved = new Map<string, string>()
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
    },
  })
  const message = { id: "msg_1", text: "All", at: 1_000 }
  keepInFlight("thread", message)
  expect(readInFlight("thread", 2_000)).toEqual(message)
  expect(readInFlight("thread", 1_000 + IN_FLIGHT_MS)).toBeNull()
  keepInFlight("thread", null)
  expect(readInFlight("thread", 2_000)).toBeNull()
  // Storage that throws keeps nothing and breaks nothing.
  vi.stubGlobal("window", {})
  expect(() => keepInFlight("thread", message)).not.toThrow()
  expect(readInFlight("thread")).toBeNull()
})
