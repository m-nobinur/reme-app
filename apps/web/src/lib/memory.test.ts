// @vitest-environment happy-dom
import {
  memoryChipText,
  Remembered,
} from "@workspace/ui/components/assistant/memory-chip"
import { MemoryLines } from "@workspace/ui/components/memory-lines"
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
    'Saved to memory: Prefers calls after 4pm; Quotes go out on Fridays (updated). Removed from memory: "Away in August"'
  )
})

it("says a removal as a removal, never as saved", () => {
  expect(
    memoryChipText({
      changes: [{ kind: "removed", text: "I don't work Fridays." }],
    })
  ).toBe('Removed from memory: "I don\'t work Fridays."')
})

it("says what a saved memory call changed in its own turn", () => {
  const chip = renderToStaticMarkup(
    createElement(Remembered as never, {
      args: {
        target: "notes",
        operations: [
          { action: "add", content: "Spare keys are in the van" },
          { action: "patch", old_text: "4pm", content: "5pm" },
        ],
      },
      result: {
        outcome: "saved",
        target: "notes",
        note: "Write saved.",
        fullness: "1%, 25/2,200 chars",
      },
    })
  )
  expect(chip).toContain(
    "Saved to memory: Spare keys are in the van; 5pm (updated)"
  )
})

it("lists a store's lines with how full it is, a stale line marked, and named edit and remove buttons", () => {
  const html = renderToStaticMarkup(
    createElement(MemoryLines, {
      busy: false,
      id: "quote-reply",
      lines: [
        {
          id: "1",
          text: "City centre quotes add parking",
          source: "You said it",
          stale: true,
        },
      ],
      max: 600,
      onRemove: () => undefined,
      onSave: () => undefined,
      title: "Quote reply",
      used: 30,
    })
  )
  expect(html).toContain("30 of 600 characters")
  expect(html).toContain("Not used for 60 days")
  expect(html).toContain(
    'aria-label="Edit &quot;City centre quotes add parking&quot;"'
  )
  expect(html).toContain(
    'aria-label="Remove &quot;City centre quotes add parking&quot;"'
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
    "Saved to memory: Prefers calls after 4pm. Removed from memory: &quot;August&quot;"
  )
  expect(chip({ outcome: "stopped", note: "Stopped." })).toBe("")
})
