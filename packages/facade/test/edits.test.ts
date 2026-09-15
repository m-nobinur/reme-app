import { describe, expect, it } from "vitest"
import { applyEdits } from "../src/edits.ts"

const file = "const a = 1\nconst b = 2\nconst c = 3\n"

describe("the batch edit", () => {
  it("applies many edits against the original in one pass", () => {
    expect(
      applyEdits(file, [
        { oldText: "const c = 3", newText: "const c = 30" },
        { oldText: "const a = 1", newText: "const a = 10" },
      ])
    ).toBe("const a = 10\nconst b = 2\nconst c = 30\n")
  })

  it("names whitespace on zero matches and asks for context on many", () => {
    expect(() =>
      applyEdits(file, [{ oldText: "const a =  1", newText: "x" }])
    ).toThrow(/whitespace/)
    expect(() =>
      applyEdits(file, [{ oldText: "const", newText: "let" }])
    ).toThrow(/more than once/)
  })

  it("refuses overlapping edits and an empty batch", () => {
    expect(() =>
      applyEdits(file, [
        { oldText: "const a = 1\nconst b", newText: "x" },
        { oldText: "const b = 2", newText: "y" },
      ])
    ).toThrow(/overlap/)
    expect(() => applyEdits(file, [])).toThrow(/no edits/)
  })
})
