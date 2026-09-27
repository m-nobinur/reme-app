import { DrizzleQueryError } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { failureCode, pgCode } from "../src/tenancy.ts"

const cancelled = Object.assign(new Error("canceling statement"), {
  code: "57014",
})
const wrapped = new DrizzleQueryError("select 1", [], cancelled)

describe("pgCode", () => {
  it.each([
    ["drizzle's wrapper, from its cause", wrapped, "57014"],
    ["the driver's own error", cancelled, "57014"],
    ["an error with no code", new Error("boom"), null],
    ["a thrown non-error", "boom", null],
    ["nothing", undefined, null],
  ])("reads %s", (_name, error, code) => {
    expect(pgCode(error)).toBe(code)
  })
})

describe("failureCode", () => {
  it.each([
    ["a code when there is one", wrapped, "57014"],
    ["the class when there is no code", new TypeError("x"), "TypeError"],
    ["unknown when there is neither", "boom", "unknown"],
    ["unknown for nothing", null, "unknown"],
  ])("logs %s", (_name, error, code) => {
    expect(failureCode(error)).toBe(code)
  })
})
