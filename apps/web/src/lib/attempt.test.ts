import { expect, it } from "vitest"
import { attemptKeys } from "./attempt"

/**
 * One idempotency key per attempt: pressing again after a timeout sends the
 * same request, and only a change to what is sent, or a success, starts a
 * new one.
 */
it("keeps one key while the input is the same", () => {
  const keys = attemptKeys()
  const first = keys.key({ open: "08:00" })
  expect(keys.key({ open: "08:00" })).toBe(first)
})

it("starts a new key when the input changes", () => {
  const keys = attemptKeys()
  const first = keys.key("Bigger logo")
  expect(keys.key("Smaller logo")).not.toBe(first)
})

it("starts a new key after a success, even for the same input", () => {
  const keys = attemptKeys()
  const first = keys.key("Bigger logo")
  keys.done()
  expect(keys.key("Bigger logo")).not.toBe(first)
})
