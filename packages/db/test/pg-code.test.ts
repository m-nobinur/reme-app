import { DrizzleQueryError } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { pgCode } from "../src/tenancy.ts"

describe("pgCode", () => {
  const cancelled = Object.assign(new Error("canceling statement"), {
    code: "57014",
  })

  it.each([
    [
      "drizzle's wrapper, from its cause",
      new DrizzleQueryError("select 1", [], cancelled),
      "57014",
    ],
    ["the driver's own error", cancelled, "57014"],
    ["an error with no code", new Error("boom"), null],
    ["a thrown non-error", "boom", null],
    ["nothing", undefined, null],
  ])("reads %s", (_name, error, code) => {
    expect(pgCode(error)).toBe(code)
  })
})
