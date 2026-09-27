import { Ulid } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { newUlid } from "../src/events.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("newUlid", () => {
  it("makes ids the contract's Ulid accepts", () => {
    const ids = Array.from({ length: 1000 }, newUlid)
    expect(ids.filter((id) => !Ulid.safeParse(id).success)).toEqual([])
  })

  it("sorts ids from one isolate in the order they were made, in one millisecond too", () => {
    // A Worker's clock stands still within a request; this one does too.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    const made = Array.from({ length: 1000 }, newUlid)
    expect([...made].sort()).toEqual(made)
  })
})
