import { expect, it } from "vitest"
import { type ListSearch, validateListSearch } from "./search"

// The router hands this raw URL state, so the test does too. Everything from a
// URL is a string or, for a repeated key, an array of strings.
const parse = (search: Record<string, unknown>): ListSearch =>
  validateListSearch(search as Parameters<typeof validateListSearch>[0])

it("defaults to the first page", () => {
  expect(parse({})).toEqual({ page: 1 })
})

it("falls back to page one rather than throwing on nonsense", () => {
  expect(parse({ page: "banana" })).toEqual({ page: 1 })
  expect(parse({ page: "0" })).toEqual({ page: 1 })
  expect(parse({ page: "-3" })).toEqual({ page: 1 })
  expect(parse({ page: "" })).toEqual({ page: 1 })
})

it("refuses number syntax a page cannot have", () => {
  expect(parse({ page: "0x10" })).toEqual({ page: 1 })
  expect(parse({ page: "2.7" })).toEqual({ page: 1 })
  expect(parse({ page: " 3 " })).toEqual({ page: 3 })
})

it("never yields a non-finite page", () => {
  for (const page of ["1e999", "Infinity", "-Infinity", "NaN"]) {
    const result = parse({ page })
    expect(Number.isFinite(result.page)).toBe(true)
    expect(result.page).toBe(1)
  }
})

it("bounds the page so it cannot reach an offset unchecked", () => {
  expect(parse({ page: "1000000000" })).toEqual({ page: 10_000 })
  expect(parse({ page: 1e9 })).toEqual({ page: 10_000 })
})

it("truncates a fractional page that came from a link, not a URL", () => {
  expect(parse({ page: 2.7 })).toEqual({ page: 2 })
})

it("keeps a trimmed query and drops a blank one", () => {
  expect(parse({ q: "  mop  " })).toEqual({ page: 1, q: "mop" })
  expect(parse({ q: "   " })).toEqual({ page: 1 })
})

it("takes the first value when a parameter repeats", () => {
  expect(parse({ q: ["a", "b"] })).toEqual({ page: 1, q: "a" })
  expect(parse({ page: ["2", "9"] })).toEqual({ page: 2 })
})

it("bounds the query length", () => {
  expect(parse({ q: "x".repeat(500) }).q).toHaveLength(200)
})
