import { memoryChipText } from "@workspace/ui/components/assistant/memory-chip"
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
