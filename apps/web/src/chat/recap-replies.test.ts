import {
  waitsOnRecap,
  waitsToSkip,
} from "@workspace/ui/components/assistant/ask-open"
import { expect, it } from "vitest"

const call = (args: object, result?: object) => ({
  type: "tool-call",
  toolCallId: "call_ask_open",
  toolName: "ask_open",
  args,
  ...(result ? { result } : {}),
})

it("shows the recap's replies while the recap waits, and never a skip", () => {
  const recap = [call({ about: "recap" })]
  expect(waitsOnRecap(recap)).toBe(true)
  expect(waitsToSkip(recap)).toBe(false)
})

it("not once the recap is answered, nor under any other question", () => {
  expect(waitsOnRecap([call({ about: "recap" }, { answer: "skipped" })])).toBe(
    false
  )
  expect(
    waitsOnRecap([call({ about: "business.audience", skippable: true })])
  ).toBe(false)
  expect(waitsOnRecap(undefined)).toBe(false)
})
