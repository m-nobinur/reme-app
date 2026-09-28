import {
  TOOL_CALL_CANCELLED as CANCELLED,
  CreateReminderOutput,
  CreateReminderRequest,
  GetPreviewOutput,
} from "@workspace/contracts"
import {
  askFactView,
  decisionView,
  isHeld,
  NOT_DONE,
  readView,
  requestChangeView,
  UNCONFIRMED,
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
  ).toEqual({ state: "error", text, message: NOT_DONE })
  // The api's text is written for the model and never shown; an unknown
  // outcome says so in the owner's words.
  expect(
    requestChangeView({
      args: CHANGE,
      approval: { approved: true },
      isError: true,
      result: {
        error:
          "unknown_outcome (orchestrator.timeout): the tool did not report back",
      },
    })
  ).toEqual({ state: "error", text, message: UNCONFIRMED })
  // Before the approval request exists, the model is still writing it.
  expect(requestChangeView({ args: { text: "Add Sat" } })).toEqual({
    state: "drafting",
    text: "Add Sat",
  })
})

const REMINDER = { title: "Call the window supplier", due_at: null }

it("reads every state of a tool that waits on the owner", () => {
  const view = (part: object) =>
    decisionView(
      { args: REMINDER, ...part },
      CreateReminderRequest,
      CreateReminderOutput
    )
  expect(view({ args: { title: "Call" } })).toEqual({ state: "drafting" })
  expect(view({ approval: {} })).toEqual({
    state: "asking",
    input: REMINDER,
  })
  expect(view({ approval: { approved: true } })).toEqual({
    state: "responding",
    input: REMINDER,
    approved: true,
  })
  expect(
    view({
      approval: { approved: true },
      result: { outcome: "created", due_at: null },
    })
  ).toEqual({
    state: "done",
    input: REMINDER,
    output: { outcome: "created", due_at: null },
  })
  expect(
    view({
      approval: { approved: false },
      isError: true,
      result: { error: "Tool approval denied" },
    })
  ).toEqual({ state: "denied", input: REMINDER })
  expect(view({ isError: true, result: { error: CANCELLED } })).toEqual({
    state: "cancelled",
    input: REMINDER,
  })
  expect(
    view({
      approval: { approved: true },
      isError: true,
      result: { error: "unknown_outcome (x): the tool did not report back" },
    })
  ).toEqual({ state: "unconfirmed", input: REMINDER })
  expect(
    view({
      approval: { approved: true },
      isError: true,
      result: { error: "tool_failed: the tool stopped before it answered." },
    })
  ).toEqual({ state: "failed", input: REMINDER })
  // No yes is ever offered on a target the owner could not read.
  expect(view({ args: { title: "" }, approval: {} })).toEqual({
    state: "broken",
  })
  expect(
    view({ approval: { approved: true }, result: { outcome: "made" } })
  ).toEqual({ state: "broken" })
})

it("reads every state of a tool that only looks", () => {
  const view = (part: object) =>
    readView({ args: {}, ...part }, GetPreviewOutput)
  const ready = {
    outcome: "ready",
    assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
    version: 4,
    expires_at: "2026-09-28T18:00:00.000Z",
  }
  expect(view({})).toEqual({ state: "working" })
  expect(view({ result: ready })).toEqual({ state: "done", output: ready })
  expect(view({ result: { outcome: "ready" } })).toEqual({ state: "failed" })
  expect(view({ isError: true, result: { error: CANCELLED } })).toEqual({
    state: "cancelled",
  })
  expect(view({ isError: true, result: { error: "tool_failed" } })).toEqual({
    state: "failed",
  })
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
