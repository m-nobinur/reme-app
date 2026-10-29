// @vitest-environment happy-dom
import {
  memoryChipText,
  Remembered,
} from "@workspace/ui/components/assistant/memory-chip"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

it("says each remembered change in the owner's own line", () => {
  expect(
    memoryChipText({
      version: 4,
      changes: [
        {
          kind: "added",
          text: "Prefers calls after 4pm",
          source: "owner_said",
        },
        {
          kind: "changed",
          text: "Quotes go out on Fridays",
          source: "reflection",
        },
        { kind: "removed", text: "Away in August", source: "owner_said" },
      ],
    })
  ).toBe(
    'Saved to memory: Prefers calls after 4pm; Quotes go out on Fridays (updated); removed "Away in August"'
  )
})

it("says what a saved remember call changed in its own turn, and nothing for one that was not saved", () => {
  const chip = (result: unknown) =>
    renderToStaticMarkup(
      createElement(Remembered as never, {
        args: {
          operations: [
            { action: "add", text: "Prefers calls after 4pm" },
            { action: "remove", match: "August" },
          ],
        },
        result,
      })
    )
  expect(
    chip({ outcome: "saved", note: "Saved.", fullness: "3 of 40" })
  ).toContain(
    "Saved to memory: Prefers calls after 4pm; removed &quot;August&quot;"
  )
  expect(chip({ outcome: "stopped", note: "Stopped." })).toBe("")
})
