import { describe, expect, it } from "vitest"
import { cut } from "../src/cos/tools.ts"

/** A high surrogate with no low one after it, or a low one with none before. */
const LONE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("cut", () => {
  it.each([
    ["a pair across the limit", `${"x".repeat(499)}\u{1F600}tail`, 499],
    ["a pair just inside it", `${"x".repeat(498)}\u{1F600}tail`, 500],
    ["short text", "Needed for the footer.", 22],
  ])("keeps %s well-formed within 500 units", (_name, text, length) => {
    const kept = cut(text)
    expect(kept).toHaveLength(length)
    expect(LONE.test(kept)).toBe(false)
    expect(text.startsWith(kept)).toBe(true)
  })
})
