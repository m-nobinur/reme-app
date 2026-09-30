import {
  TOOL_CALL_CANCELLED as CANCELLED,
  CreateReminderOutput,
  CreateReminderRequest,
  GetPreviewOutput,
  OwnerChangeRequest,
  RequestChangeOutput,
} from "@workspace/contracts"
import { refusalText } from "@workspace/ui/lib/refusal"
import {
  askFactView,
  decisionView,
  isHeld,
  readView,
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
  key: "business.tagline",
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

const change = (part: object) =>
  decisionView(
    { args: CHANGE, ...part },
    OwnerChangeRequest,
    RequestChangeOutput
  )

it("reads a change the owner is asked to start, in every state", () => {
  expect(change({ args: { text: "Add Sat" } })).toEqual({ state: "drafting" })
  expect(change({ approval: {} })).toEqual({ state: "asking", input: CHANGE })
  expect(change({ approval: { approved: true } })).toEqual({
    state: "responding",
    input: CHANGE,
    approved: true,
  })
  expect(
    change({
      approval: { approved: true },
      result: { outcome: "started", build: BUILD },
    })
  ).toEqual({
    state: "done",
    input: CHANGE,
    output: { outcome: "started", build: BUILD },
  })
  expect(
    change({
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
    input: CHANGE,
    code: "change.question_open",
  })
  expect(
    change({
      approval: { approved: false },
      isError: true,
      result: { error: "Tool approval denied" },
    })
  ).toEqual({ state: "denied", input: CHANGE })
  expect(change({ isError: true, result: { error: CANCELLED } })).toEqual({
    state: "cancelled",
    input: CHANGE,
  })
})

it("never offers a yes on a change it cannot read, and says whether it still waits", () => {
  // No text, so the owner could not see what they would start.
  expect(change({ args: { text: "" }, approval: {} })).toEqual({
    state: "broken",
    waiting: true,
  })
  expect(change({ args: {}, approval: { approved: true } })).toEqual({
    state: "broken",
    waiting: false,
  })
})

it("reads only the integrity refusal as not done; any other failure may have happened", () => {
  const failure = (error: string) =>
    change({ approval: { approved: true }, isError: true, result: { error } })
  expect(
    failure(
      "tool_failed (orchestrator.contract): the builder answered in a shape we do not accept, so nothing was done."
    )
  ).toEqual({ state: "failed", input: CHANGE })
  for (const error of [
    "tool_failed: the tool stopped before it answered. Nothing is known about its result.",
    "unknown_outcome (orchestrator.timeout): the tool did not report back.",
    "Something the api never wrote.",
    "",
  ]) {
    expect(failure(error), error).toEqual({
      state: "unconfirmed",
      input: CHANGE,
    })
  }
})

it("shows a call that succeeded as done, even when its output does not parse", () => {
  // Shown as failed, it would invite the owner to start it again.
  expect(
    change({ approval: { approved: true }, result: { outcome: "started" } })
  ).toEqual({ state: "done", input: CHANGE, output: null })
  expect(
    change({ approval: { approved: true }, result: { outcome: "refused" } })
  ).toEqual({ state: "refused", input: CHANGE, code: null })
})

const REMINDER = { title: "Call the window supplier", due_at: null }

it("reads every state of a reminder the owner is asked to add", () => {
  const view = (part: object) =>
    decisionView(
      { args: REMINDER, ...part },
      CreateReminderRequest,
      CreateReminderOutput
    )
  expect(view({ approval: {} })).toEqual({ state: "asking", input: REMINDER })
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

it("says a refusal in the owner's words, never the api's", () => {
  expect(refusalText("change.question_open", "Fallback.")).toBe(
    "A build is waiting on your answer. Answer it first."
  )
  expect(refusalText("request.not_found", "Fallback.")).toBe(
    "That question is no longer waiting on you."
  )
  // A code with no line of its own, or none at all, gets the tool's line.
  expect(refusalText("assignment.kind_unknown", "Fallback.")).toBe("Fallback.")
  expect(refusalText(null, "Fallback.")).toBe("Fallback.")
  // A reminder whose outcome is unknown says so, rather than "refused".
  expect(refusalText("reminder.unconfirmed", "Fallback.")).toBe(UNCONFIRMED)
})
