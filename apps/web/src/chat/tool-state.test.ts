import { TOOL_CALL_CANCELLED as CANCELLED } from "@workspace/contracts"
import {
  askFactView,
  isHeld,
  requestChangeView,
} from "@workspace/ui/lib/tool-state"
import { expect, it } from "vitest"

/**
 * Every state of the two owner tools, from the props assistant-ui hands a
 * tool UI (`@assistant-ui/ai-sdk` 0.0.2's converter: `output-error` and
 * `output-denied` are `isError` with `{ error }`, and an approval keeps its
 * answer).
 */

const ASK = {
  key: "pricing.standard_clean_hourly",
  skippable: true,
  prefill: null,
}
const FACT = { key: "business.name", value: { name: "Probe Cleaning" } }

it("reads every ask_fact state", () => {
  expect(askFactView({ args: ASK })).toEqual({
    key: ASK.key,
    state: "pending",
    input: ASK,
  })
  expect(
    askFactView({ args: ASK, result: { answer: "stated", fact: FACT } })
  ).toMatchObject({ state: "answered", fact: FACT })
  expect(askFactView({ args: ASK, result: { answer: "skipped" } })).toEqual({
    key: ASK.key,
    state: "skipped",
  })
  expect(
    askFactView({ args: ASK, isError: true, result: { error: CANCELLED } })
  ).toEqual({ key: ASK.key, state: "cancelled" })
  expect(
    askFactView({ args: ASK, isError: true, result: { error: "Timed out" } })
  ).toEqual({ key: ASK.key, state: "error", message: "Timed out" })
  // A call the contract refuses is an error, never a form for a guessed key.
  expect(askFactView({ args: { key: "business.fax" } })).toMatchObject({
    key: null,
    state: "error",
  })
})

const CHANGE = { text: "Build my website from the details I gave you." }
const BUILD = {
  assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
  kind: "site.build",
  state: "queued",
  goal: CHANGE.text,
  revision: null,
  created_at: "2026-09-27T10:00:00.000Z",
  updated_at: "2026-09-27T10:00:00.000Z",
}

it("reads every request_change state", () => {
  const text = CHANGE.text
  expect(requestChangeView({ args: CHANGE, approval: {} })).toEqual({
    state: "approval-requested",
    text,
  })
  expect(
    requestChangeView({ args: CHANGE, approval: { approved: true } })
  ).toEqual({ state: "responding", text, approved: true })
  expect(
    requestChangeView({
      args: CHANGE,
      approval: { approved: true },
      result: { outcome: "started", build: BUILD },
    })
  ).toMatchObject({ state: "started", text })
  expect(
    requestChangeView({
      args: CHANGE,
      approval: { approved: true },
      result: {
        outcome: "refused",
        error: {
          class: "validation",
          code: "change.question_open",
          message: "Answer the open question first.",
        },
      },
    })
  ).toEqual({
    state: "refused",
    text,
    message: "Answer the open question first.",
  })
  expect(
    requestChangeView({
      args: CHANGE,
      approval: { approved: false },
      isError: true,
      result: { error: "Tool approval denied" },
    })
  ).toEqual({ state: "denied", text })
  expect(
    requestChangeView({
      args: CHANGE,
      isError: true,
      result: { error: CANCELLED },
    })
  ).toEqual({ state: "cancelled", text })
  expect(
    requestChangeView({
      args: CHANGE,
      isError: true,
      result: { error: "Lost" },
    })
  ).toEqual({ state: "error", text, message: "Lost" })
})

/** A tool call as assistant-ui holds it in a message's parts. */
const call = (toolCallId: string, extra: object = {}) => ({
  type: "tool-call",
  toolCallId,
  ...extra,
})

it("a yes is held only while another card in its message still waits", () => {
  const yes = call("a", { approval: { id: "x", approved: true } })
  const waiting = call("b", { approval: { id: "y" } })
  const read = call("r", { result: { site: {} } })
  expect(isHeld([read, yes, waiting], "a")).toBe(true)
  // The waiting card itself is not held, and nor is a yes on its own,
  // already sent, or one whose only company is a read.
  expect(isHeld([yes, waiting], "b")).toBe(false)
  expect(isHeld([yes], "a")).toBe(false)
  expect(isHeld([read, yes], "a")).toBe(false)
  // Once the step has come back, nothing is held.
  expect(
    isHeld(
      [
        call("a", { approval: { approved: true }, result: { outcome: "x" } }),
        call("b", { approval: { approved: false }, isError: true }),
      ],
      "a"
    )
  ).toBe(false)
})
