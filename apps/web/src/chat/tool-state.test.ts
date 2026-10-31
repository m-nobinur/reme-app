import {
  APPROVAL_EXPIRED,
  TOOL_CALL_CANCELLED as CANCELLED,
  CreateReminderOutput,
  CreateReminderRequest,
  GetChangeOutput,
  OwnerChangeRequest,
  RequestChangeOutput,
  TOOL_FAILED,
  TOOL_REPEATED,
} from "@workspace/contracts"
import { phoneText } from "@workspace/ui/lib/facts"
import { refusalText } from "@workspace/ui/lib/refusal"
import {
  askChoiceView,
  askDetailsView,
  askFactView,
  askOpenView,
  askUploadView,
  choiceText,
  decisionView,
  detailsText,
  isHeld,
  isRepeat,
  isRetried,
  readView,
  showsProgress,
  supersededBy,
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
          code: "change.build_busy",
          message: "A build is finishing.",
        },
      },
    })
  ).toEqual({
    state: "refused",
    input: CHANGE,
    code: "change.build_busy",
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

it("reads a yes the api refused as too late or not matching the card as expired", () => {
  expect(
    change({
      approval: { approved: true },
      isError: true,
      result: {
        error: `${APPROVAL_EXPIRED}: the owner's yes on this card has expired, so nothing was done.`,
      },
    })
  ).toEqual({ state: "expired", input: CHANGE })
  // Only the line's own prefix: the words alone are not the api's line.
  expect(
    change({
      approval: { approved: true },
      isError: true,
      result: { error: "The approval expired." },
    })
  ).toEqual({ state: "unconfirmed", input: CHANGE })
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
    readView({ args: {}, ...part }, GetChangeOutput)
  const none = { outcome: "none" }
  expect(view({})).toEqual({ state: "working" })
  expect(view({ result: none })).toEqual({ state: "done", output: none })
  expect(view({ result: { outcome: "found" } })).toEqual({ state: "failed" })
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
  expect(refusalText("change.build_busy", "Fallback.")).toBe(
    "A build is finishing. Ask again once it is ready for you."
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

const CHOICE = {
  step: "pronouns",
  options: [
    { id: "he_him", label: "he/him", hint: null, visual: null },
    { id: "they_them", label: "they/them", hint: null, visual: null },
  ],
  multiple: true,
  preselected: [],
  other: { label: "Something else", placeholder: "Your words" },
  skippable: true,
}

it("reads every ask_choice state, and the answer in the owner's words", () => {
  expect(askChoiceView({ args: CHOICE })).toEqual({
    state: "pending",
    input: CHOICE,
  })
  const chosen = { answer: "chosen", ids: ["they_them"], other: "xe/xem" }
  const answered = askChoiceView({ args: CHOICE, result: chosen })
  expect(answered).toEqual({ state: "answered", input: CHOICE, output: chosen })
  if (answered.state === "answered") {
    expect(choiceText(answered.input, answered.output)).toBe(
      "they/them, xe/xem"
    )
  }
  expect(choiceText(null, { ids: ["gone"], other: null })).toBe("gone")
  expect(
    askChoiceView({ args: CHOICE, result: { answer: "skipped" } }).state
  ).toBe("skipped")
  expect(
    askChoiceView({ args: CHOICE, isError: true, result: { error: CANCELLED } })
      .state
  ).toBe("cancelled")
  expect(askChoiceView({ args: { step: "nope" } }).state).toBe("error")
  expect(
    askChoiceView({ args: CHOICE, result: { answer: "chosen" } }).state
  ).toBe("error")
})

it("reads every ask_open state", () => {
  const args = { about: "quote.form" }
  expect(askOpenView({ args })).toEqual({ state: "pending", input: args })
  const stated = { answer: "stated", text: "Rooms and how often" }
  expect(askOpenView({ args, result: stated })).toEqual({
    state: "answered",
    input: args,
    output: stated,
  })
  expect(askOpenView({ args, result: { answer: "skipped" } }).state).toBe(
    "skipped"
  )
  expect(
    askOpenView({ args, isError: true, result: { error: CANCELLED } }).state
  ).toBe("cancelled")
  expect(askOpenView({ args: { about: "media.uploads" } }).state).toBe("error")
  expect(
    askOpenView({ args, result: { answer: "stated", text: " " } }).state
  ).toBe("error")
})

it("reads every ask_upload state", () => {
  const input = {
    accept: ["image/png"],
    max_files: 2,
    max_bytes: 1000,
    skippable: false,
  }
  const asset = {
    id: "0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
    name: "shop.png",
    content_type: "image/png",
    bytes: 900,
  }
  expect(askUploadView({ args: input })).toEqual({ state: "pending", input })
  expect(
    askUploadView({
      args: input,
      result: { answer: "uploaded", assets: [asset] },
    })
  ).toEqual({
    state: "answered",
    input,
    output: { answer: "uploaded", assets: [asset] },
  })
  expect(
    askUploadView({ args: input, result: { answer: "uploaded", assets: [] } })
      .state
  ).toBe("error")
  expect(
    askUploadView({ args: input, isError: true, result: { error: "boom" } })
  ).toEqual({ state: "error", message: "boom" })
})

it("reads a card for the retired hourly price as skipped, answered or not", () => {
  const args = {
    key: "pricing.standard_clean_hourly",
    skippable: true,
    prefill: null,
  }
  const skipped = { key: null, state: "skipped" }
  expect(askFactView({ args })).toEqual(skipped)
  expect(
    askFactView({
      args,
      result: {
        answer: "stated",
        fact: {
          key: "pricing.standard_clean_hourly",
          value: { amount_minor: 3500, currency: "GBP" },
        },
      },
    })
  ).toEqual(skipped)
})

it("reads every ask_details state, and the answer in the owner's words", () => {
  const contact = {
    step: "contact",
    prefill: [{ key: "business.email", value: { address: "a@b.example" } }],
    skippable: false,
  }
  expect(askDetailsView({ args: contact })).toEqual({
    state: "pending",
    input: contact,
  })
  const stated = {
    answer: "stated",
    facts: [
      { key: "business.phone", value: { e164: "+447700900123" } },
      { key: "business.email", value: { address: "a@b.example" } },
    ],
  }
  const answered = askDetailsView({ args: contact, result: stated })
  expect(answered).toEqual({
    state: "answered",
    input: contact,
    output: stated,
  })
  if (answered.state === "answered") {
    expect(detailsText(answered.output.facts)).toBe(
      "07700 900123 · a@b.example"
    )
  }
  expect(
    detailsText([
      { key: "assistant.name", value: { name: "Ava" } },
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.tone", value: { id: "friendly" } },
    ])
  ).toBe("Ava · she/her · Friendly")
  expect(
    askDetailsView({ args: contact, result: { answer: "skipped" } }).state
  ).toBe("skipped")
  expect(
    askDetailsView({
      args: contact,
      isError: true,
      result: { error: CANCELLED },
    }).state
  ).toBe("cancelled")
  // A prefill outside the step, and an answer with no facts, are broken.
  expect(
    askDetailsView({
      args: {
        ...contact,
        prefill: [{ key: "assistant.name", value: { name: "Ava" } }],
      },
    }).state
  ).toBe("error")
  expect(
    askDetailsView({ args: contact, result: { answer: "stated", facts: [] } })
      .state
  ).toBe("error")
})

it("writes a number the way it is written in its country, and leaves others", () => {
  expect(phoneText("+447700900123")).toBe("07700 900123")
  expect(phoneText("+442079460000")).toBe("020 7946 0000")
  expect(phoneText("+14155550100")).toBe("(415) 555-0100")
  expect(phoneText("+33142685300")).toBe("+33142685300")
})

it("hides a refusal the same tool was called again after, and only that", () => {
  const changeCall = (id: string, outcome?: string) =>
    call(id, {
      toolName: "request_change",
      ...(outcome && { result: { outcome } }),
    })
  const parts = [changeCall("a", "refused"), changeCall("b", "started")]
  expect(isRetried(parts, "a")).toBe(true)
  expect(isRetried(parts, "b")).toBe(false)
  expect(isRetried([changeCall("a", "refused")], "a")).toBe(false)
  expect(
    isRetried(
      [changeCall("a", "refused"), call("b", { toolName: "get_workspace" })],
      "a"
    )
  ).toBe(false)
})

it("leaves the reply's status line to a reply with nothing at work on screen", () => {
  const quiet = { remember: () => null }
  const text = { type: "text", text: "Lovely." }
  expect(showsProgress([], quiet)).toBe(false)
  expect(
    showsProgress([call("a", { toolName: "get_workspace", result: {} })], quiet)
  ).toBe(false)
  expect(
    showsProgress([call("a", { toolName: "request_change" })], quiet)
  ).toBe(true)
  expect(showsProgress([text], quiet)).toBe(true)
  expect(showsProgress([call("b", { toolName: "remember" })], quiet)).toBe(
    false
  )
  expect(
    showsProgress([call("c", { toolName: "x", isError: true })], quiet)
  ).toBe(false)
})

it("folds cancelled cards of one kind into the card that replaced them", () => {
  const toolCall = (
    id: string,
    cancelled = false,
    toolName = "create_reminder"
  ) => ({
    type: "tool-call",
    toolName,
    toolCallId: id,
    ...(cancelled ? { isError: true, result: { error: CANCELLED } } : {}),
  })
  const messages = [
    { content: [toolCall("a", true)] },
    { content: [{ type: "text" }, toolCall("x", true, "buy_domain")] },
    { content: [toolCall("b", true), toolCall("c")] },
  ]
  expect(supersededBy(messages, "create_reminder", "a")).toBe("later")
  expect(supersededBy(messages, "create_reminder", "b")).toBe("later")
  expect(supersededBy(messages, "create_reminder", "c")).toBe(2)
  // The last of its kind, even cancelled, keeps its own line.
  expect(supersededBy(messages, "buy_domain", "x")).toBe(0)
})

it("knows a call refused as a repeat, which shows nothing, from any other failure", () => {
  const failed = (error: string) => ({ isError: true, result: { error } })
  expect(isRepeat(failed(`${TOOL_REPEATED}: find_domain already ran`))).toBe(
    true
  )
  expect(isRepeat(failed(`${TOOL_FAILED} (cos.integrity): no`))).toBe(false)
  expect(isRepeat(failed(CANCELLED))).toBe(false)
  expect(isRepeat({ result: { error: TOOL_REPEATED } })).toBe(false)
})
