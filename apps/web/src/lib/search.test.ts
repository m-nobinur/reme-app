import { expect, it } from "vitest"
import { type ListSearch, validateListSearch } from "./search"

// The router hands this raw URL state, so the test does too.
const parse = (search: Record<string, unknown>): ListSearch =>
  validateListSearch(search as Parameters<typeof validateListSearch>[0])

it("defaults to the first page", () => {
  expect(parse({})).toEqual({ page: 1 })
})

it("falls back to page one rather than throwing on nonsense", () => {
  expect(parse({ page: "banana" })).toEqual({ page: 1 })
  expect(parse({ page: 0 })).toEqual({ page: 1 })
  expect(parse({ page: -3 })).toEqual({ page: 1 })
})

it("truncates a fractional page", () => {
  expect(parse({ page: 2.7 })).toEqual({ page: 2 })
})

it("keeps a trimmed query and drops a blank one", () => {
  expect(parse({ q: "  mop  " })).toEqual({ page: 1, q: "mop" })
  expect(parse({ q: "   " })).toEqual({ page: 1 })
  expect(parse({ q: 42 })).toEqual({ page: 1 })
})
