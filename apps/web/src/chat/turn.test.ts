import {
  ANSWER_TEXT_MAX,
  TOOL_CALL_CANCELLED as CANCELLED,
  ChatRequest,
} from "@workspace/contracts"
import {
  PICK_FOR_ME,
  SESSION_ENDED,
  SKIPPED,
} from "@workspace/ui/lib/tool-state"
import { afterEach, expect, it, vi } from "vitest"
import type { ChatMessage } from "./message"
import {
  cancelOvertaken,
  chatFetch,
  chatTurn,
  NO_BUSINESS,
  replyText,
  replyTo,
  sendsOn,
  turnBody,
  withStoredCard,
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

const choice = (state: string, extra: object = {}) =>
  ({
    type: "tool-ask_choice",
    toolCallId: "call_tone",
    state,
    input: {
      step: "tone",
      options: [
        { id: "friendly", label: "Friendly", hint: null, visual: null },
        { id: "casual", label: "Casual", hint: null, visual: null },
      ],
      multiple: false,
      preselected: [],
      other: null,
      skippable: false,
    },
    ...extra,
  }) as unknown as Part

const details = (state: string, extra: object = {}) =>
  ({
    type: "tool-ask_details",
    toolCallId: "call_assistant",
    state,
    input: { step: "assistant", prefill: [], skippable: true },
    ...extra,
  }) as unknown as Part

const NAMED = {
  answer: "stated",
  facts: [
    { key: "assistant.name", value: { name: "Ava" } },
    { key: "assistant.pronouns", value: { id: "she_her" } },
    { key: "assistant.tone", value: { id: "friendly" } },
  ],
}

const photos = (state: string, extra: object = {}) =>
  ({
    type: "tool-ask_upload",
    toolCallId: "call_photos",
    state,
    input: {
      accept: ["image/jpeg"],
      max_files: 12,
      max_bytes: 5_242_880,
      skippable: true,
    },
    ...extra,
  }) as unknown as Part

const ASSET = {
  id: "0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
  name: "van.jpg",
  content_type: "image/jpeg",
  bytes: 120_000,
}

it("a choice or an upload sends the call it resolves, as the contract reads it", () => {
  for (const [part, output] of [
    [
      choice("output-available", {
        output: { answer: "chosen", ids: ["casual"], other: null },
      }),
      { answer: "chosen", ids: ["casual"], other: null },
    ],
    [
      photos("output-available", {
        output: { answer: "uploaded", assets: [ASSET] },
      }),
      { answer: "uploaded", assets: [ASSET] },
    ],
  ] as const) {
    const messages = [assistant(part)]
    // The owner's reply sends it, never the SDK on its own.
    expect(sendsOn({ messages })).toBe(false)
    expect(
      ChatRequest.parse(chatTurn(CONVERSATION, "act", messages)).turn
    ).toEqual({
      kind: "results",
      message_id: "msg_assistant",
      results: [
        {
          kind: "answer",
          tool_call_id: (part as { toolCallId: string }).toolCallId,
          output,
        },
      ],
    })
  }
})

it("an answered card reads back as the owner's words", () => {
  expect(replyText(ask("output-available", { output: STATED }))).toBe(
    "Probe Cleaning"
  )
  expect(
    replyText(
      choice("output-available", {
        output: { answer: "chosen", ids: ["casual"], other: "Warm" },
      })
    )
  ).toBe("Casual, Warm")
  expect(
    replyText(
      photos("output-available", {
        output: { answer: "uploaded", assets: [ASSET] },
      })
    )
  ).toBe("Uploaded van.jpg")
  expect(
    replyText(
      photos("output-available", {
        output: { answer: "uploaded", assets: [ASSET, ASSET] },
      })
    )
  ).toBe("Uploaded 2 photos")
  const open = (state: string, extra: object = {}) =>
    ({
      type: "tool-ask_open",
      toolCallId: "call_open",
      state,
      input: { about: "quote.form" },
      ...extra,
    }) as unknown as ChatMessage["parts"][number]
  expect(
    replyText(
      open("output-available", {
        output: { answer: "stated", text: "Rooms and how often" },
      })
    )
  ).toBe("Rooms and how often")
  for (const card of [open, ask, choice, photos]) {
    expect(
      replyText(card("output-available", { output: { answer: "skipped" } }))
    ).toBe(SKIPPED)
  }
  // Only an answer is a reply: not a card still open, cancelled or a change.
  expect(replyText(ask("input-available"))).toBeNull()
  expect(replyText(ask("output-error", { errorText: CANCELLED }))).toBeNull()
  expect(
    replyText(change("output-available", { output: { outcome: "refused" } }))
  ).toBeNull()
})

it("an answer to a card becomes the owner's reply, sent with the card's answers", () => {
  const open = [assistant(ask("input-available"))]
  const reply = replyTo(open, { toolCallId: "call_name", output: STATED })
  expect(reply).toEqual({
    role: "user",
    parts: [{ type: "text", text: "Probe Cleaning" }],
    metadata: { reply: true },
  })
  const sent = [
    assistant(ask("output-available", { output: STATED })),
    { ...(reply as ChatMessage), id: "msg_reply" },
  ]
  expect(ChatRequest.parse(chatTurn(CONVERSATION, "act", sent)).turn).toEqual({
    kind: "results",
    message_id: "msg_assistant",
    results: [{ kind: "answer", tool_call_id: "call_name", output: STATED }],
    reply: { message_id: "msg_reply", text: "Probe Cleaning" },
  })
})

it("no reply while another call in the step waits, for an error, or for a change", () => {
  const two = [assistant(ask("input-available"), choice("input-available"))]
  expect(replyTo(two, { toolCallId: "call_name", output: STATED })).toBeNull()
  expect(
    replyTo([assistant(ask("input-available"))], {
      toolCallId: "call_name",
      state: "output-error",
    })
  ).toBeNull()
  expect(
    replyTo([assistant(change("input-available"))], {
      toolCallId: "call_change",
      output: { outcome: "refused" },
    })
  ).toBeNull()
  // A card in an earlier step is not the one waiting.
  expect(
    replyTo([assistant(ask("input-available"), { type: "step-start" }, read)], {
      toolCallId: "call_name",
      output: STATED,
    })
  ).toBeNull()
})

it("a typed reply overtakes an open choice or upload card, as the api stores it", () => {
  const cancelled = cancelOvertaken([
    assistant(choice("input-available"), photos("input-available")),
  ])
  expect(cancelled.at(-1)?.parts.slice(1)).toEqual([
    choice("output-error", { errorText: CANCELLED }),
    photos("output-error", { errorText: CANCELLED }),
  ])
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

it("shows a card a typed yes answered as the stored message has it, and nothing else", () => {
  const card = change("approval-requested", { approval: { id: "appr_1" } })
  const typed: ChatMessage = {
    id: "msg_user",
    role: "user",
    parts: [{ type: "text", text: "yes please" }],
  }
  // Sent: the card shows cancelled, the reply streams in below.
  const shown = [...cancelOvertaken([assistant(card)]), typed]
  expect(shown[0]?.parts.slice(1)).toEqual([
    change("output-error", { errorText: CANCELLED }),
  ])
  const done = change("output-available", {
    output: { outcome: "started" },
    approval: { id: "appr_1", approved: true },
  })
  const other: ChatMessage = { ...assistant(ask("input-available")), id: "x" }
  const swapped = withStoredCard(shown, [assistant(done), other], "call_change")
  expect(swapped[0]?.parts.slice(1)).toEqual([done])
  expect(swapped.slice(1)).toEqual([typed])
  // A card the stored rows do not hold leaves the thread as it is.
  expect(withStoredCard(shown, [other], "call_change")).toBe(shown)
  // A declined card reads as declined.
  const declined = change("output-denied", {
    approval: { id: "appr_1", approved: false },
  })
  expect(
    withStoredCard(shown, [assistant(declined)], "call_change")[0]?.parts[1]
  ).toEqual(declined)
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

it("sends on after an approval, and not after an answer or the last stored step", () => {
  expect(
    sendsOn({
      messages: [assistant(ask("output-available", { output: STATED }))],
    })
  ).toBe(false)
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

it("a details card sends the facts it resolves, and reads back as the owner's words", () => {
  const open = [assistant(details("input-available"))]
  const reply = replyTo(open, { toolCallId: "call_assistant", output: NAMED })
  expect(reply).toEqual({
    role: "user",
    parts: [{ type: "text", text: "Ava · she/her · Friendly" }],
    metadata: { reply: true },
  })
  const sent = [
    assistant(details("output-available", { output: NAMED })),
    { ...(reply as ChatMessage), id: "msg_reply" },
  ]
  expect(sendsOn({ messages: sent.slice(0, 1) })).toBe(false)
  expect(ChatRequest.parse(chatTurn(CONVERSATION, "act", sent)).turn).toEqual({
    kind: "results",
    message_id: "msg_assistant",
    results: [
      { kind: "answer", tool_call_id: "call_assistant", output: NAMED },
    ],
    reply: { message_id: "msg_reply", text: "Ava · she/her · Friendly" },
  })
  expect(
    replyText(details("output-available", { output: { answer: "skipped" } }))
  ).toBe(SKIPPED)
  expect(replyText(details("input-available"))).toBeNull()
})

const tray = (state: string, extra: object = {}) =>
  ({
    type: "tool-ask_design",
    toolCallId: "call_design",
    state,
    input: {
      questions: [
        {
          id: "palette",
          question: "Which colour palette feels right for your business?",
          visual: "palette",
          card: {
            step: "palette",
            options: [
              {
                id: "ocean",
                label: "Ocean",
                hint: null,
                visual: null,
              },
              { id: "forest", label: "Forest", hint: null, visual: null },
            ],
            multiple: false,
            preselected: [],
            other: { label: "Write your own…", placeholder: "A colour code" },
            skippable: true,
          },
        },
        {
          id: "pages",
          question: "Which pages should the site have?",
          visual: "text",
          card: {
            step: "pages",
            options: [
              {
                id: "essentials",
                label: "The essentials",
                hint: null,
                visual: null,
              },
              {
                id: "everything",
                label: "Everything",
                hint: null,
                visual: null,
              },
            ],
            multiple: false,
            preselected: [],
            other: null,
            skippable: true,
          },
        },
      ],
    },
    ...extra,
  }) as unknown as Part

it("a finished design tray sends its answers, and reads back as the owner's words", () => {
  const output = {
    answers: {
      palette: { own: "Navy and gold" },
      pages: { choice: "everything" },
    },
    skip_all: false,
  }
  const reply = replyTo([assistant(tray("input-available"))], {
    toolCallId: "call_design",
    output,
  })
  expect(reply).toEqual({
    role: "user",
    parts: [
      {
        type: "text",
        text: "Navy and gold · Everything",
      },
    ],
    metadata: { reply: true },
  })
  const sent = [
    assistant(tray("output-available", { output })),
    { ...(reply as ChatMessage), id: "msg_reply" },
  ]
  expect(sendsOn({ messages: sent.slice(0, 1) })).toBe(false)
  expect(
    ChatRequest.parse(chatTurn(CONVERSATION, "act", sent)).turn
  ).toMatchObject({
    kind: "results",
    results: [{ kind: "answer", tool_call_id: "call_design", output }],
  })
  // Nothing picked reads Skipped, Pick for me itself; an answer skipped is left out.
  expect(
    replyText(
      tray("output-available", { output: { answers: {}, skip_all: false } })
    )
  ).toBe(SKIPPED)
  expect(
    replyText(
      tray("output-available", { output: { ...output, skip_all: true } })
    )
  ).toBe(PICK_FOR_ME)
  expect(
    replyText(
      tray("output-available", {
        output: {
          answers: {
            palette: { skipped: true },
            pages: { choice: "essentials" },
          },
          skip_all: false,
        },
      })
    )
  ).toBe("The essentials")
  // Several ticked read as their labels, in the order given.
  expect(
    replyText(
      tray("output-available", {
        output: {
          answers: { pages: { choices: ["everything", "essentials"] } },
          skip_all: false,
        },
      })
    )
  ).toBe("Everything, The essentials")
  expect(replyText(tray("input-available"))).toBeNull()
})

it("saves one answer of the tray as a results turn that carries only that answer", async () => {
  const sent: RequestInit[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(init)
      return new Response(null, { status: 204 })
    })
  )
  const { saveDesignAnswer } = await import("./design")
  await saveDesignAnswer({
    conversationId: CONVERSATION,
    messageId: "msg_assistant",
    toolCallId: "call_design",
    output: { answers: { palette: { choice: "ocean" } }, skip_all: false },
  })
  expect(ChatRequest.parse(JSON.parse(sent[0]?.body as string)).turn).toEqual({
    kind: "results",
    message_id: "msg_assistant",
    results: [
      {
        kind: "answer",
        tool_call_id: "call_design",
        output: { answers: { palette: { choice: "ocean" } }, skip_all: false },
      },
    ],
  })
})
