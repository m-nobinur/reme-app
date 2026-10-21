import { afterEach, describe, expect, it, vi } from "vitest"
import {
  lowerNextDue,
  NEXT_DUE_KEY,
  type NextDue,
  WAKE_DELAY_MAX_S,
} from "../src/due.ts"

const NOW = Date.UTC(2026, 9, 22, 9, 0)
const MINUTE = 60_000

function fakeKv(value?: NextDue) {
  const map = new Map<string, string>()
  if (value) map.set(NEXT_DUE_KEY, JSON.stringify(value))
  return {
    stored: () => JSON.parse(map.get(NEXT_DUE_KEY) ?? "null") as NextDue | null,
    get: async (key: string) => JSON.parse(map.get(key) ?? "null"),
    put: async (key: string, raw: string) => void map.set(key, raw),
  }
}

const fakeQueue = () => ({ send: vi.fn(async () => undefined) })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("lowerNextDue", () => {
  it("lowers a later stored time, and leaves an earlier one and an empty key", async () => {
    const later = fakeKv({ next: NOW + 10 * MINUTE, scanned: NOW })
    await lowerNextDue(later, new Date(NOW + MINUTE))
    expect(later.stored()).toEqual({ next: NOW + MINUTE, scanned: NOW })

    const earlier = fakeKv({ next: NOW, scanned: NOW })
    await lowerNextDue(earlier, new Date(NOW + MINUTE))
    expect(earlier.stored()).toEqual({ next: NOW, scanned: NOW })

    // No key means the next minute scans anyway.
    const empty = fakeKv()
    await lowerNextDue(empty, new Date(NOW + MINUTE))
    expect(empty.stored()).toBeNull()
  })

  it("wakes the scan a second after the due time, whatever KV held", async () => {
    vi.useFakeTimers({ now: NOW })
    const queue = fakeQueue()
    const kv = fakeKv({ next: NOW, scanned: NOW })
    await lowerNextDue(kv, new Date(NOW + 90_500), queue)
    expect(queue.send).toHaveBeenCalledExactlyOnceWith(
      { kind: "scan" },
      { delaySeconds: 92 }
    )
  })

  it("wakes at once for a time already past", async () => {
    vi.useFakeTimers({ now: NOW })
    const queue = fakeQueue()
    await lowerNextDue(fakeKv(), new Date(NOW - MINUTE), queue)
    expect(queue.send).toHaveBeenCalledWith(
      { kind: "scan" },
      { delaySeconds: 0 }
    )
  })

  it("leaves a time past the queue's longest delay to the cron", async () => {
    vi.useFakeTimers({ now: NOW })
    const queue = fakeQueue()
    await lowerNextDue(fakeKv(), new Date(NOW + WAKE_DELAY_MAX_S * 1000), queue)
    expect(queue.send).not.toHaveBeenCalled()
  })

  it("never throws when KV or the queue fails, and still wakes past a KV failure", async () => {
    vi.useFakeTimers({ now: NOW })
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const broken = {
      get: async () => {
        throw new Error("kv down")
      },
      put: async () => undefined,
    }
    const queue = fakeQueue()
    await lowerNextDue(broken, new Date(NOW), queue)
    expect(queue.send).toHaveBeenCalledOnce()

    const refusing = {
      send: async () => {
        throw new Error("queue down")
      },
    }
    await expect(
      lowerNextDue(fakeKv(), new Date(NOW), refusing)
    ).resolves.toBeUndefined()
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map(([line]) => JSON.parse(String(line)))
    ).toEqual([
      { code: "jobs.next_due_unwritten", error: "Error" },
      { code: "jobs.wake_unsent", error: "Error" },
    ])
  })
})
