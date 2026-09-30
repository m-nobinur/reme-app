import {
  ANSWER_TEXT_MAX,
  TOOL_CALL_CANCELLED as CANCELLED,
  ChatRequest,
} from "@workspace/contracts"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import { afterEach, expect, it, vi } from "vitest"
import type { ChatMessage } from "./message"
import {
  cancelOvertaken,
  chatFetch,
  chatTurn,
  NO_BUSINESS,
  sendsOn,
  turnBody,
} from "./turn"

const CONVERSATION = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Parts as `apps/api` stores and streams them. */
type Part = ChatMessage["parts"][number]

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

const assistant = (...parts: Part[]): ChatMessage => ({
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
    time_zone: ZONE,
    turn: { kind: "message", message_id: "msg_user", text: "Hello" },
  })
})

it("a message sent in website change mode says so; a results turn never does", async () => {
  const typed: ChatMessage = {
    id: "msg_user",
    role: "user",
    parts: [{ type: "text", text: "Add Saturday hours" }],
  }
  const body = turnBody(
    () => Promise.resolve({ remoteId: CONVERSATION }),
    () => "act",
    { current: undefined }
  )
  const sent = await body({
    messages: [typed],
    body: { intent: "site_change" },
  })
  expect(ChatRequest.parse(sent.body).intent).toBe("site_change")
  const plain = await body({ messages: [typed] })
  expect(plain.body).not.toHaveProperty("intent")
  const results = chatTurn(
    CONVERSATION,
    "act",
    [assistant(ask("output-available", { output: STATED }))],
    "site_change"
  )
  expect(results).not.toHaveProperty("intent")
})

it("every turn carries the browser's time zone", () => {
  const message = chatTurn(CONVERSATION, "act", [
    { id: "msg_user", role: "user", parts: [{ type: "text", text: "Hi" }] },
  ])
  const results = chatTurn(CONVERSATION, "act", [
    assistant(ask("output-available", { output: STATED })),
  ])
  for (const request of [message, results]) {
    expect(ChatRequest.parse(request).time_zone).toBe(ZONE)
  }
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
    kind: "results",
    message_id: "msg_assistant",
    results: [
      {
        kind: "answer",
        tool_call_id: "call_name",
        output: { answer: "skipped" },
      },
    ],
  })
})

it("a yes or a no sends the approval it answers, with the owner's reason", () => {
  for (const approval of [
    { id: "appr_1", approved: true },
    { id: "appr_1", approved: false, reason: "Not this week" },
  ]) {
    const request = chatTurn(CONVERSATION, "act", [
      assistant(change("approval-responded", { approval })),
    ])
    const { id, ...rest } = approval
    expect(ChatRequest.parse(request).turn).toEqual({
      kind: "results",
      message_id: "msg_assistant",
      results: [{ kind: "approval", approval_id: id, ...rest }],
    })
  }
})

it("sends a yes or no on any tool that asked for one", () => {
  const question = {
    type: "tool-answer_question",
    toolCallId: "call_question",
    state: "approval-responded",
    input: { request_id: CONVERSATION, value: "Saturdays" },
    approval: { id: "appr_2", approved: false },
  } as unknown as Part
  const request = chatTurn(CONVERSATION, "act", [assistant(question)])
  expect(ChatRequest.parse(request).turn).toEqual({
    kind: "results",
    message_id: "msg_assistant",
    results: [{ kind: "approval", approval_id: "appr_2", approved: false }],
  })
})

it("trims the reason, drops a blank one and cuts a long one to the cap", () => {
  const reasonOf = (reason: string) => {
    const { turn } = ChatRequest.parse(
      chatTurn(CONVERSATION, "act", [
        assistant(
          change("approval-responded", {
            approval: { id: "appr_1", approved: false, reason },
          })
        ),
      ])
    )
    const [result] = turn.kind === "results" ? turn.results : []
    return result?.kind === "approval" ? result.reason : undefined
  }
  expect(reasonOf("  Not this week  ")).toBe("Not this week")
  expect(reasonOf("   ")).toBeUndefined()
  expect(reasonOf("a".repeat(ANSWER_TEXT_MAX + 50))).toBe(
    "a".repeat(ANSWER_TEXT_MAX)
  )
})

it("sends every result of the last step in one turn", () => {
  const request = chatTurn(CONVERSATION, "act", [
    assistant(
      ask("output-available", { output: STATED }),
      change("approval-responded", {
        approval: { id: "appr_1", approved: true },
      })
    ),
  ])
  expect(ChatRequest.parse(request).turn).toEqual({
    kind: "results",
    message_id: "msg_assistant",
    results: [
      { kind: "answer", tool_call_id: "call_name", output: STATED },
      { kind: "approval", approval_id: "appr_1", approved: true },
    ],
  })
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

it("a typed message cancels a yes or no held back and never sent", () => {
  for (const approved of [true, false]) {
    const cancelled = cancelOvertaken([
      assistant(
        change("approval-responded", { approval: { id: "appr_1", approved } }),
        answerQuestion("approval-requested", { approval: { id: "appr_2" } })
      ),
    ])
    expect(cancelled.at(-1)?.parts.slice(1)).toEqual([
      change("output-error", { errorText: CANCELLED }),
      answerQuestion("output-error", { errorText: CANCELLED }),
    ])
  }
})

it("a send records its own message before it waits on anything", async () => {
  const earlier: ChatMessage = {
    id: "msg_earlier",
    role: "user",
    parts: [{ type: "text", text: "Earlier" }],
  }
  const now: ChatMessage = {
    id: "msg_now",
    role: "user",
    parts: [{ type: "text", text: "Now" }],
  }
  const sending = { current: earlier as ChatMessage | undefined }
  const body = turnBody(
    () => Promise.reject(new Error("The conversation could not be opened.")),
    () => "act",
    sending
  )
  await expect(body({ messages: [now] })).rejects.toThrow()
  expect(sending.current).toBe(now)
})

it("a typed message drops a call still streaming its input, as a reload would", () => {
  const streaming = {
    type: "tool-create_reminder",
    toolCallId: "call_streaming",
    state: "input-streaming",
    input: { title: "Call" },
  } as unknown as Part
  const cancelled = cancelOvertaken([
    assistant(
      streaming,
      change("approval-requested", { approval: { id: "a" } })
    ),
  ])
  expect(cancelled.at(-1)?.parts.slice(1)).toEqual([
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

const read = {
  type: "tool-get_workspace",
  toolCallId: "call_read",
  state: "output-available",
  input: {},
  output: { site: { host: null, live_version: null } },
} as unknown as Part

const answerQuestion = (state: string, extra: object = {}) =>
  ({
    type: "tool-answer_question",
    toolCallId: "call_question",
    state,
    input: { request_id: CONVERSATION, value: "Saturdays, 9 to 1" },
    ...extra,
  }) as unknown as Part

it("waits for every card in the step, then sends them as one turn", () => {
  const halfway = [
    assistant(
      read,
      change("approval-responded", {
        approval: { id: "appr_1", approved: true },
      }),
      answerQuestion("approval-requested", { approval: { id: "appr_2" } })
    ),
  ]
  expect(sendsOn({ messages: halfway })).toBe(false)

  const answered = [
    assistant(
      read,
      change("approval-responded", {
        approval: { id: "appr_1", approved: true },
      }),
      answerQuestion("approval-responded", {
        approval: { id: "appr_2", approved: false },
      })
    ),
  ]
  expect(sendsOn({ messages: answered })).toBe(true)
  expect(
    ChatRequest.parse(chatTurn(CONVERSATION, "act", answered)).turn
  ).toEqual({
    kind: "results",
    message_id: "msg_assistant",
    results: [
      { kind: "approval", approval_id: "appr_1", approved: true },
      { kind: "approval", approval_id: "appr_2", approved: false },
    ],
  })
})

it("never sends a step the server finished by itself", () => {
  const settled = change("output-available", {
    approval: { id: "appr_1", approved: true },
    output: { outcome: "refused" },
  })
  // A results turn the model answered and ended on a read at its step
  // limit: the last step's only call is the read, which has its output.
  // This is the case the owner-result check exists for.
  expect(
    sendsOn({ messages: [assistant(settled, { type: "step-start" }, read)] })
  ).toBe(false)
  // One the fallback answered. `apps/api` opens a new step before the
  // settled calls and stores it (`stream` and `fallbackTurn` in chat.ts), so
  // the last step is empty and the SDK's own checks already say no.
  expect(
    sendsOn({ messages: [assistant(read, settled, { type: "step-start" })] })
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

it("a session with no business reads as that, not as the api's words", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          class: "permission",
          code: "org.unresolved",
          message: "This session is not signed in to an organisation we hold.",
          occurred_at: "2026-09-30T20:00:00.000Z",
          detail: {},
        },
        { status: 403 }
      )
    )
  )
  await expect(chatFetch("/api/chat")).rejects.toThrow(NO_BUSINESS)
})

it("the route's own 401 says the session ended, and its 413 says why", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "This request carries no session we can read." },
        { status: 401 }
      )
    )
  )
  await expect(chatFetch("/api/chat")).rejects.toThrow(SESSION_ENDED)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "This message is too long to send." },
        { status: 413 }
      )
    )
  )
  await expect(chatFetch("/api/chat")).rejects.toThrow(
    "This message is too long to send."
  )
})
