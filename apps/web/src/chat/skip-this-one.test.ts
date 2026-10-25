import { waitsToSkip } from "@workspace/ui/components/assistant/ask-open"
import { expect, it } from "vitest"

const call = (toolName: string, args: object, result?: object) => ({
  type: "tool-call",
  toolCallId: `call_${toolName}`,
  toolName,
  args,
  ...(result ? { result } : {}),
})

it("waits to be skipped on an optional question asked in words, while it is open", () => {
  expect(
    waitsToSkip([
      call("ask_open", { about: "business.audience", skippable: true }),
    ])
  ).toBe(true)
  expect(
    waitsToSkip([
      call("ask_fact", {
        key: "business.proof",
        skippable: true,
        prefill: null,
      }),
    ])
  ).toBe(true)
  expect(
    waitsToSkip([
      call(
        "ask_open",
        { about: "business.audience", skippable: true },
        { answer: "skipped" }
      ),
    ])
  ).toBe(false)
})

it("never on a required question, nor on one the tray asks with its own Skip", () => {
  expect(waitsToSkip([call("ask_open", { about: "quote.form" })])).toBe(false)
  expect(
    waitsToSkip([
      call("ask_open", { about: "business.offerings", skippable: false }),
    ])
  ).toBe(false)
  expect(
    waitsToSkip([
      call("ask_fact", {
        key: "business.proof",
        skippable: false,
        prefill: null,
      }),
    ])
  ).toBe(false)
  expect(
    waitsToSkip([
      call("ask_fact", {
        key: "hours.weekday",
        skippable: true,
        prefill: null,
      }),
    ])
  ).toBe(false)
  expect(waitsToSkip(undefined)).toBe(false)
})
