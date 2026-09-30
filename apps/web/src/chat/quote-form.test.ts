import {
  TOOL_CALL_CANCELLED as CANCELLED,
  ChatRequest,
  QUOTE_FIELDS_MIN,
  type QuoteField,
  QuoteFields,
} from "@workspace/contracts"
import {
  canDrop,
  confirmedFields,
  draftOf,
  dropField,
  keptFields,
  labelProblem,
  QUOTE_LABEL_MAX,
  quoteSummary,
  renameField,
  restoreField,
  setRequired,
  waitsOnQuoteForm,
} from "@workspace/ui/lib/quote-form"
import { reviewQuoteFormView } from "@workspace/ui/lib/tool-state"
import { describe, expect, it } from "vitest"
import { toUIMessage } from "./history"
import type { ChatMessage } from "./message"
import { chatTurn, quoteChanges, replyTo, sendsOn } from "./turn"

const field = (key: string, label: string, extra: Partial<QuoteField> = {}) =>
  ({
    key,
    label,
    type: "text",
    required: true,
    hint: null,
    options: null,
    ...extra,
  }) as QuoteField

const LIMOUSINE = [
  field("pickup", "Pick-up address"),
  field("dropoff", "Drop-off address"),
  field("passengers", "Passengers", { type: "number" }),
  field("occasion", "Occasion", {
    type: "select",
    required: false,
    options: ["Wedding", "Airport transfer"],
  }),
]

describe("editing a proposed quote form", () => {
  it("drops and restores a question in its place", () => {
    const dropped = dropField(draftOf(LIMOUSINE), "dropoff")
    expect(keptFields(dropped).map((f) => f.key)).toEqual([
      "pickup",
      "passengers",
      "occasion",
    ])
    expect(dropped.map((row) => row.field.key)).toEqual(
      LIMOUSINE.map((f) => f.key)
    )
    expect(keptFields(restoreField(dropped, "dropoff"))).toEqual(LIMOUSINE)
  })

  it("never drops below the contract's minimum", () => {
    let draft = draftOf(LIMOUSINE)
    for (const key of ["pickup", "dropoff", "passengers", "occasion"]) {
      draft = dropField(draft, key)
    }
    expect(keptFields(draft)).toHaveLength(QUOTE_FIELDS_MIN)
    expect(canDrop(draft)).toBe(false)
    expect(dropField(draft, "occasion")).toBe(draft)
    expect(canDrop(restoreField(draft, "pickup"))).toBe(true)
  })

  it("renames a label, keeps its key and caps its length", () => {
    const draft = renameField(draftOf(LIMOUSINE), "pickup", "Collection point")
    expect(keptFields(draft)[0]).toEqual({
      ...LIMOUSINE[0],
      label: "Collection point",
    })
    const long = renameField(draft, "pickup", "x".repeat(200))
    expect(keptFields(long)[0]?.label).toHaveLength(QUOTE_LABEL_MAX)
  })

  it("refuses a blank or a repeated label, and lets a dropped one repeat", () => {
    const blank = renameField(draftOf(LIMOUSINE), "pickup", "   ")
    expect(labelProblem(blank, "pickup")).toBe("Give this question a label.")
    expect(confirmedFields(blank)).toHaveProperty("problem")

    const twice = renameField(draftOf(LIMOUSINE), "dropoff", "pick-up ADDRESS")
    expect(labelProblem(twice, "dropoff")).toBe(
      "Two questions have this label."
    )
    expect(confirmedFields(twice)).toHaveProperty("problem")
    expect(confirmedFields(dropField(twice, "pickup"))).toHaveProperty("fields")
  })

  it("confirms the kept list, trimmed, with unique keys the contract takes", () => {
    const draft = setRequired(
      renameField(
        dropField(draftOf(LIMOUSINE), "occasion"),
        "passengers",
        "  How many travelling  "
      ),
      "dropoff",
      false
    )
    const result = confirmedFields(draft)
    if (!("fields" in result)) throw new Error(result.problem)
    expect(result.fields.map((f) => [f.key, f.label, f.required])).toEqual([
      ["pickup", "Pick-up address", true],
      ["dropoff", "Drop-off address", false],
      ["passengers", "How many travelling", true],
    ])
    expect(QuoteFields.safeParse(result.fields).success).toBe(true)
    expect(new Set(result.fields.map((f) => f.key)).size).toBe(3)
  })

  it("reads the confirmed list back with its count and labels", () => {
    expect(quoteSummary(LIMOUSINE.slice(0, 2))).toBe(
      "Your quote form asks 2 questions: Pick-up address, Drop-off address."
    )
  })
})

const INPUT = { fields: LIMOUSINE, note: "The route and the party size." }

it("reads every review_quote_form state", () => {
  expect(reviewQuoteFormView({ args: INPUT })).toEqual({
    state: "pending",
    input: INPUT,
  })
  const confirmed = { answer: "confirmed", fields: LIMOUSINE.slice(0, 2) }
  expect(reviewQuoteFormView({ args: INPUT, result: confirmed })).toEqual({
    state: "answered",
    input: INPUT,
    output: confirmed,
  })
  const changes = { answer: "changes", text: "Ask about luggage" }
  expect(reviewQuoteFormView({ args: INPUT, result: changes }).state).toBe(
    "answered"
  )
  expect(
    reviewQuoteFormView({
      args: INPUT,
      isError: true,
      result: { error: CANCELLED },
    }).state
  ).toBe("cancelled")
  expect(
    reviewQuoteFormView({ args: { fields: [LIMOUSINE[0]], note: null } }).state
  ).toBe("error")
  expect(
    reviewQuoteFormView({
      args: INPUT,
      result: { answer: "confirmed", fields: [] },
    }).state
  ).toBe("error")
})

const CONVERSATION = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"
type Part = ChatMessage["parts"][number]

const review = (state: string, extra: object = {}) =>
  ({
    type: "tool-review_quote_form",
    toolCallId: "call_quote",
    state,
    input: INPUT,
    ...extra,
  }) as unknown as Part

const assistant = (...parts: Part[]): ChatMessage => ({
  id: "msg_assistant",
  role: "assistant",
  parts: [{ type: "step-start" }, ...parts],
})

describe("the review card's turn", () => {
  it("sends a confirmed list as the owner's reply, with the answer to its call", () => {
    const output = { answer: "confirmed" as const, fields: LIMOUSINE }
    const waiting = [assistant(review("input-available"))]
    const reply = replyTo(waiting, { toolCallId: "call_quote", output })
    expect(reply).toEqual({
      role: "user",
      parts: [{ type: "text", text: quoteSummary(LIMOUSINE) }],
      metadata: { reply: true },
    })
    // The reply sends it, never the SDK on its own.
    const answered = assistant(review("output-available", { output }))
    expect(sendsOn({ messages: [answered] })).toBe(false)
    const sent = [answered, { ...(reply as ChatMessage), id: "msg_reply" }]
    expect(ChatRequest.parse(chatTurn(CONVERSATION, "act", sent)).turn).toEqual(
      {
        kind: "results",
        message_id: "msg_assistant",
        results: [{ kind: "answer", tool_call_id: "call_quote", output }],
        reply: { message_id: "msg_reply", text: quoteSummary(LIMOUSINE) },
      }
    )
  })

  it("takes a typed message as the change, sent as the owner's typed reply", () => {
    const waiting = [assistant(review("input-available"))]
    const changes = quoteChanges(waiting, "  Ask about luggage too ")
    expect(changes).toEqual({
      tool: "review_quote_form",
      toolCallId: "call_quote",
      output: { answer: "changes", text: "Ask about luggage too" },
    })
    // One reply carries the words, marked typed so a failed turn gives them
    // back to the composer.
    const reply = replyTo(waiting, changes as NonNullable<typeof changes>)
    expect(reply).toEqual({
      role: "user",
      parts: [{ type: "text", text: "Ask about luggage too" }],
      metadata: { reply: true, typed: true },
    })
    const answered = assistant(
      review("output-available", { output: changes?.output })
    )
    const sent = [answered, { ...(reply as ChatMessage), id: "msg_reply" }]
    expect(
      ChatRequest.parse(chatTurn(CONVERSATION, "act", sent)).turn
    ).toMatchObject({
      kind: "results",
      results: [{ kind: "answer", output: { answer: "changes" } }],
      reply: { message_id: "msg_reply", text: "Ask about luggage too" },
    })
  })

  it("leaves a message alone that is a website change, too long, or has no card to answer", () => {
    const waiting = [assistant(review("input-available"))]
    expect(quoteChanges(waiting, "Add Saturday hours", "site_change")).toBe(
      null
    )
    expect(quoteChanges(waiting, "x".repeat(501))).toBe(null)
    expect(
      quoteChanges(
        [assistant(review("output-error", { errorText: CANCELLED }))],
        "Hello"
      )
    ).toBe(null)
    expect(
      quoteChanges(
        [
          ...waiting,
          {
            id: "msg_user",
            role: "user",
            parts: [{ type: "text", text: "Hi" }],
          },
        ],
        "Hi"
      )
    ).toBe(null)
  })

  it("replays a stored answer without sending it again", () => {
    const stored = toUIMessage({
      id: "msg_assistant",
      parent_id: null,
      format: "ai-sdk/v6",
      content: {
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-review_quote_form",
            toolCallId: "call_quote",
            state: "output-available",
            input: INPUT,
            output: { answer: "confirmed", fields: LIMOUSINE },
          },
          { type: "step-start" },
          { type: "text", text: "Saved. The site will ask those." },
        ],
        metadata: { custom: { createdAt: "2026-10-01T10:00:00.000Z" } },
      },
      feedback: null,
    })
    expect(stored.parts[1]).toMatchObject({
      type: "tool-review_quote_form",
      output: { answer: "confirmed", fields: LIMOUSINE },
    })
    expect(sendsOn({ messages: [stored] })).toBe(false)
  })
})

it("tells the composer a proposed form waits, from the thread's own parts", () => {
  const call = { type: "tool-call", toolName: "review_quote_form" }
  expect(waitsOnQuoteForm([call])).toBe(true)
  expect(waitsOnQuoteForm([{ ...call, result: { answer: "changes" } }])).toBe(
    false
  )
  expect(waitsOnQuoteForm([{ ...call, isError: true }])).toBe(false)
  expect(waitsOnQuoteForm(undefined)).toBe(false)
})
