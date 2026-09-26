import { ChatRequest } from "@workspace/contracts"
import { CANCELLED } from "@workspace/ui/lib/tool-state"
import type { UIMessage } from "ai"
import { afterEach, expect, it, vi } from "vitest"
import { cancelOvertaken, chatFetch, chatTurn, sendsOn } from "./turn"

const CONVERSATION = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"

/** Parts as `apps/api` stores and streams them. */
type Part = UIMessage["parts"][number]

const ask = (state: string, extra: object = {}) =>
  ({
    type: "tool-ask_fact",
    toolCallId: "call_name",
    state,
    input: { key: "business.name", skippable: false, prefill: null },
    ...extra,
  }) as unknown as Part

const change = (state: string, extra: object = {}) =>
  ({
    type: "tool-request_change",
    toolCallId: "call_change",
    state,
    input: { text: "Add Saturday hours" },
    ...extra,
  }) as unknown as Part

const STATED = {
  answer: "stated",
  fact: { key: "business.name", value: { name: "Probe Cleaning" } },
}

const assistant = (...parts: Part[]): UIMessage => ({
  id: "msg_assistant",
  role: "assistant",
  parts: [{ type: "step-start" }, ...parts],
})

it("a typed message sends only itself, with the mode", () => {
  const request = chatTurn(CONVERSATION, "ask", [
    assistant(ask("output-error", { errorText: CANCELLED })),
    { id: "msg_user", role: "user", parts: [{ type: "text", text: "Hello" }] },
  ])
  expect(ChatRequest.parse(request)).toEqual({
    conversation_id: CONVERSATION,
    mode: "ask",
    turn: { kind: "message", message_id: "msg_user", text: "Hello" },
  })
})

it("an answer sends the call it resolves, from the last step only", () => {
  const earlier = {
    ...ask("output-available", { output: STATED }),
    toolCallId: "call_earlier",
  }
  const request = chatTurn(CONVERSATION, "act", [
    assistant(
      earlier as Part,
      { type: "step-start" },
      ask("output-available", { output: { answer: "skipped" } })
    ),
  ])
  expect(ChatRequest.parse(request).turn).toEqual({
    kind: "answer",
    message_id: "msg_assistant",
    tool_call_id: "call_name",
    output: { answer: "skipped" },
  })
})

it("a yes or a no sends the approval it answers", () => {
  for (const approved of [true, false]) {
    const request = chatTurn(CONVERSATION, "act", [
      assistant(
        change("approval-responded", { approval: { id: "appr_1", approved } })
      ),
    ])
    expect(ChatRequest.parse(request).turn).toEqual({
      kind: "approval",
      message_id: "msg_assistant",
      approval_id: "appr_1",
      approved,
    })
  }
})

it("refuses to send a turn with nothing new in it", () => {
  expect(() =>
    chatTurn(CONVERSATION, "act", [
      assistant(ask("output-available", { output: STATED }), {
        type: "step-start",
      }),
    ])
  ).toThrow()
})

it("a typed message cancels what waits on the owner, as the api does", () => {
  const cancelled = cancelOvertaken([
    assistant(
      ask("input-available"),
      change("approval-requested", { approval: { id: "appr_1" } })
    ),
  ])
  expect(cancelled.at(-1)?.parts.slice(1)).toEqual([
    ask("output-error", { errorText: CANCELLED }),
    change("output-error", { errorText: CANCELLED }),
  ])
})

it("a not now stays not now when the owner types next", () => {
  // The row `apps/api` keeps after the owner said no. assistant-ui's own
  // cancel rewrote this part to output-error, which a reload contradicted.
  const denied = [
    assistant(
      change("output-denied", { approval: { id: "appr_1", approved: false } }),
      ask("output-available", { output: STATED }),
      { type: "step-start" }
    ),
  ]
  expect(cancelOvertaken(denied)).toBe(denied)
})

it("sends on after an answer or an approval, and not after the last stored step", () => {
  expect(
    sendsOn({
      messages: [assistant(ask("output-available", { output: STATED }))],
    })
  ).toBe(true)
  expect(
    sendsOn({
      messages: [
        assistant(
          change("approval-responded", {
            approval: { id: "a", approved: true },
          })
        ),
      ],
    })
  ).toBe(true)
  // Each continuation opens a new step, so the finished change is not the
  // last step and the thread does not send again.
  expect(
    sendsOn({
      messages: [
        assistant(
          change("output-available", {
            approval: { id: "a", approved: true },
            output: { outcome: "refused" },
          }),
          { type: "step-start" }
        ),
      ],
    })
  ).toBe(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it("a refusal reads as the api's own words", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          class: "validation",
          code: "chat.stale",
          message: "This conversation has moved on. Reload it.",
          detail: {},
          occurred_at: "2026-09-27T10:00:00.000Z",
        },
        { status: 409 }
      )
    )
  )
  await expect(chatFetch("/api/chat")).rejects.toThrow(
    "This conversation has moved on. Reload it."
  )
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html>", { status: 502 }))
  )
  await expect(chatFetch("/api/chat")).rejects.toThrow("(502)")
})
