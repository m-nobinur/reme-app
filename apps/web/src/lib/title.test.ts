import { titleText } from "@workspace/ui/lib/title"
import { expect, it } from "vitest"

it("keeps a title on one line, trimmed, with single spaces", () => {
  expect(titleText("  Weekend\n prices\t\tfor   June  ")).toBe(
    "Weekend prices for June"
  )
})

it("refuses a title with no words", () => {
  expect(titleText("")).toBeNull()
  expect(titleText(" \n\t ")).toBeNull()
})

it("cuts a long title to the contract's 120 UTF-16 units, never inside a character", () => {
  expect(titleText("a".repeat(130))).toBe("a".repeat(120))
  // 119 letters and an emoji two units long: the emoji would make 121, so it
  // goes whole rather than leaving half a character.
  expect(titleText(`${"a".repeat(119)}🧽`)).toBe("a".repeat(119))
  expect(titleText(`${"a".repeat(118)}🧽`)).toBe(`${"a".repeat(118)}🧽`)
})
