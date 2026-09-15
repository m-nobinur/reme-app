import { describe, expect, it } from "vitest"
import { applyEdits } from "../src/edits.ts"

const P = "src/site-config.ts"
const file = "const a = 1\nconst b = 2\nconst c = 3\n"

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected a refusal")
}

describe("the batch edit, on Pi's rules", () => {
  it("applies many edits against the original in one pass", () => {
    expect(
      applyEdits(
        file,
        [
          { oldText: "const c = 3", newText: "const c = 30" },
          { oldText: "const a = 1", newText: "const a = 10" },
        ],
        P
      )
    ).toBe("const a = 10\nconst b = 2\nconst c = 30\n")
  })

  it("names the path and the whitespace rule when an anchor is missing", () => {
    expect(
      refusal(() =>
        applyEdits(file, [{ oldText: "const a =  1", newText: "x" }], P)
      )
    ).toBe(
      `Could not find the exact text in ${P}. The old text must match exactly including all whitespace and newlines.`
    )
    expect(
      refusal(() =>
        applyEdits(
          file,
          [
            { oldText: "const a = 1", newText: "x" },
            { oldText: "const z = 9", newText: "y" },
          ],
          P
        )
      )
    ).toBe(
      `Could not find edits[1] in ${P}. The oldText must match exactly including all whitespace and newlines.`
    )
  })

  it("asks for more context when an anchor matches more than once", () => {
    expect(
      refusal(() => applyEdits(file, [{ oldText: "const", newText: "let" }], P))
    ).toBe(
      `Found 3 occurrences of the text in ${P}. The text must be unique. Please provide more context to make it unique.`
    )
    expect(
      refusal(() =>
        applyEdits(
          file,
          [
            { oldText: "const a = 1", newText: "x" },
            { oldText: " = ", newText: "=" },
          ],
          P
        )
      )
    ).toBe(
      `Found 3 occurrences of edits[1] in ${P}. Each oldText must be unique. Please provide more context to make it unique.`
    )
  })

  it("refuses overlapping edits by index and writes nothing", () => {
    expect(
      refusal(() =>
        applyEdits(
          file,
          [
            { oldText: "const a = 1\nconst b", newText: "x" },
            { oldText: "const b = 2", newText: "y" },
          ],
          P
        )
      )
    ).toBe(
      `edits[0] and edits[1] overlap in ${P}. Merge them into one edit or target disjoint regions.`
    )
  })

  it("refuses an empty batch, an empty anchor and a change that changes nothing", () => {
    expect(refusal(() => applyEdits(file, [], P))).toBe(
      "Edit tool input is invalid. edits must contain at least one replacement."
    )
    expect(
      refusal(() => applyEdits(file, [{ oldText: "", newText: "x" }], P))
    ).toBe(`oldText must not be empty in ${P}.`)
    expect(
      refusal(() =>
        applyEdits(
          file,
          [{ oldText: "const a = 1", newText: "const a = 1" }],
          P
        )
      )
    ).toBe(
      `No changes made to ${P}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    )
  })

  it("matches past trailing whitespace and smart quotes, and keeps untouched lines byte for byte", () => {
    const source = 'const a = "x"   \nconst b = 2\t\nconst c = 3\n'
    expect(
      applyEdits(
        source,
        [{ oldText: "const a = “x”", newText: 'const a = "y"' }],
        P
      )
    ).toBe('const a = "y"\nconst b = 2\t\nconst c = 3\n')
  })

  it("does not forgive leading indentation", () => {
    expect(
      refusal(() =>
        applyEdits(
          '  name: "",\n',
          [{ oldText: 'name: "",\n  x', newText: "y" }],
          P
        )
      )
    ).toMatch(/^Could not find the exact text/)
    expect(
      refusal(() =>
        applyEdits(
          '  name: "",\n',
          [{ oldText: '    name: "",', newText: "y" }],
          P
        )
      )
    ).toMatch(/^Could not find the exact text/)
  })

  it("keeps CRLF line endings and a byte order mark", () => {
    expect(
      applyEdits(
        "﻿a = 1\r\nb = 2\r\n",
        [{ oldText: "a = 1\nb = 2", newText: "a = 10\nb = 20" }],
        P
      )
    ).toBe("﻿a = 10\r\nb = 20\r\n")
  })
})
