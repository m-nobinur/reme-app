import { describe, expect, it } from "vitest"
import { digits, record, secret, text } from "./input"

describe("reading a server function payload", () => {
  it("turns a non-string into empty rather than into its toString", () => {
    // The failure this pins: String({}) is "[object Object]", which is a
    // perfectly valid string to hand WorkOS as an email address.
    for (const value of [{}, [], 42, null, undefined, true]) {
      expect(text(value)).toBe("")
      expect(secret(value)).toBe("")
      expect(digits(value)).toBe("")
    }
  })

  it("trims a pasted email but not a password", () => {
    expect(text("  owner@example.com  ")).toBe("owner@example.com")
    // A leading space is a legitimate character in a password and trimming it
    // would silently reject a password the person set elsewhere.
    expect(secret("  spaced  ")).toBe("  spaced  ")
  })

  it("bounds every field", () => {
    expect(text("a".repeat(2000)).length).toBe(512)
    expect(secret("a".repeat(2000)).length).toBe(512)
    expect(digits("1".repeat(50))).toBe("111111")
  })

  it("keeps only digits in a one-time code", () => {
    expect(digits("481 502")).toBe("481502")
    expect(digits("48-15-02")).toBe("481502")
    expect(digits("abc")).toBe("")
  })

  it("gives an object for anything that is not one", () => {
    expect(record(null)).toEqual({})
    expect(record("no")).toEqual({})
    expect(record({ a: 1 })).toEqual({ a: 1 })
  })
})
