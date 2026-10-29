import { expect, it } from "vitest"
import { FRESH_MS, lastShown, revealer } from "./reveal"

const memory = () => {
  const items = new Map<string, string>()
  return {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
  }
}

const broken = () => ({
  getItem: (): string | null => {
    throw new Error("SecurityError")
  },
  setItem: () => {
    throw new Error("SecurityError")
  },
})

const NOW = Date.parse("2026-10-01T10:00:00.000Z")
const at = (ms: number) => new Date(NOW - ms).toISOString()

it("plays an opening message once, then never again in this browser", () => {
  const store = memory()
  const reveal = revealer(() => store)
  expect(reveal.unseen("m1", at(0))).toBe(true)
  reveal.seen("m1")
  expect(reveal.unseen("m1", at(0))).toBe(false)
  // A second browser's store, or another message, has its own first time.
  expect(revealer(() => memory()).unseen("m1", at(0))).toBe(true)
  expect(reveal.unseen("m2", at(0))).toBe(true)
})

it("an old opening plays in too when storage works: it was never seen here", () => {
  const reveal = revealer(() => memory())
  expect(reveal.unseen("m1", at(FRESH_MS * 100))).toBe(true)
})

it("with storage that throws, only a message under two minutes old plays in", () => {
  const reveal = revealer(broken, () => NOW)
  expect(reveal.unseen("m1", at(FRESH_MS - 1000))).toBe(true)
  expect(reveal.unseen("m1", at(FRESH_MS + 1000))).toBe(false)
  expect(reveal.unseen("m1", null)).toBe(false)
  expect(() => reveal.seen("m1")).not.toThrow()
})

it("keeps the last message shown per conversation, apart from the reveal's", () => {
  const store = memory()
  const last = lastShown(() => store)
  expect(last.get("c1")).toBeNull()
  last.set("c1", "m1")
  last.set("c1", "m2")
  last.set("c2", "m9")
  expect(last.get("c1")).toBe("m2")
  expect(last.get("c2")).toBe("m9")
  expect(revealer(() => store).unseen("m2", at(0))).toBe(true)
})

it("with storage that throws, no conversation has a last message shown", () => {
  const last = lastShown(broken)
  expect(() => last.set("c1", "m1")).not.toThrow()
  expect(last.get("c1")).toBeNull()
})
