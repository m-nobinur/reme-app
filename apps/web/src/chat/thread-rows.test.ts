import { rowKeys } from "@workspace/ui/components/assistant/thread"
import { expect, it } from "vitest"

const user = { id: "u1", role: "user" }

it("keeps the placeholder reply's row for the reply that replaces it", () => {
  const waiting = rowKeys([user, { id: "placeholder", role: "assistant" }])
  const replied = rowKeys([user, { id: "row-7", role: "assistant" }])
  expect(replied).toBe(waiting)
})

it("gives every row its own key, two replies in a row included", () => {
  const keys = rowKeys([
    { id: "a0", role: "assistant" },
    user,
    { id: "a1", role: "assistant" },
    { id: "a2", role: "assistant" },
  ]).split(" ")
  expect(new Set(keys).size).toBe(4)
  expect(keys[1]).toBe("u1")
})

it("has no rows for an empty thread", () => {
  expect(rowKeys([])).toBe("")
})
