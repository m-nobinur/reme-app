import { describe, expect, it } from "vitest"
import { z } from "zod"
import { RequestChangeOutput } from "../src/chat.ts"
import {
  AnswerQuestionInput,
  AnswerQuestionOutput,
  COS_TOOLS,
  CosFeedback,
  CosToolName,
  CosToolResult,
  CosTurn,
  CosWorkspace,
  CreateReminderOutput,
  GetPreviewOutput,
  RecordReviewInput,
  RecordReviewOutput,
} from "../src/cos.ts"
import {
  ANSWER_TEXT_MAX,
  CreateReminderRequest,
  FactValue,
} from "../src/owner.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

const tools = Object.entries(COS_TOOLS)

type Found = { keys: string[]; formats: string[]; open: number }

/**
 * Every property name and string format anywhere in a JSON Schema, and how
 * many objects take keys they do not name.
 */
function walk(node: unknown, found: Found) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found)
  } else if (typeof node === "object" && node !== null) {
    const { type, properties, additionalProperties, format } = node as Record<
      string,
      unknown
    >
    if (typeof properties === "object" && properties !== null) {
      found.keys.push(...Object.keys(properties))
    }
    if (type === "object" && additionalProperties !== false) found.open++
    if (typeof format === "string") found.formats.push(format)
    for (const value of Object.values(node)) walk(value, found)
  }
  return found
}

describe("COS_TOOLS", () => {
  // A tool added or dropped is a decision, so the list is written out.
  it("has exactly the ten tools, in order", () => {
    const ten = [
      "get_workspace",
      "get_facts",
      "get_preview",
      "request_change",
      "answer_question",
      "create_reminder",
      "record_review",
      "check_domain",
      "connect_domain",
      "remove_domain",
    ]
    expect(Object.keys(COS_TOOLS)).toStrictEqual(ten)
    expect(CosToolName.options).toStrictEqual(ten)
  })

  // Provider tool APIs take an object as a tool's parameters and refuse a
  // union at the root.
  it.each(tools)("%s takes an object at its root", (_name, { input }) => {
    const schema = z.toJSONSchema(input) as Record<string, unknown>
    expect(schema.type).toBe("object")
    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema).not.toHaveProperty("allOf")
  })

  // OpenAI refuses a tool whose schema has a regex lookaround (seen
  // 2026-10-16: every turn failed over the hostname pattern).
  it.each(tools)("%s has no lookaround in any pattern", (_name, { input }) => {
    const patterns = JSON.stringify(z.toJSONSchema(input)).match(
      /"pattern":"(?:[^"\\]|\\.)*"/g
    )
    for (const p of patterns ?? []) expect(p).not.toMatch(/\(\?[=!<]/)
  })

  // The model never sees a tenancy id, and a signed link is a bearer
  // capability the tool UI fetches for itself. An open object could carry
  // either, so every object names its keys.
  it.each(tools)(
    "%s shows the model no org id, staff id, URL or open object",
    (_name, { output }) => {
      const { keys, formats, open } = walk(z.toJSONSchema(output), {
        keys: [],
        formats: [],
        open: 0,
      })
      expect(open).toBe(0)
      expect(
        keys.filter(
          (k) =>
            k === "org_id" ||
            k.endsWith("_staff_id") ||
            k === "cf_ids" ||
            /cloudflare|hostname_id/.test(k)
        )
      ).toStrictEqual([])
      expect(formats.filter((f) => f === "uri")).toStrictEqual([])
    }
  )
})

describe("AnswerQuestionInput", () => {
  const request_id = "5e6f7081-92a3-4e0f-8021-5c6d7e8f9001"
  it.each([
    ["a fact", samples.AnswerQuestionInput],
    ["a text answer", { request_id, value: "Saturdays 09:00 to 13:00" }],
  ])("accepts %s", (_name, input) => {
    expect(verdict("AnswerQuestionInput", AnswerQuestionInput, input)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    [
      "a fact that does not parse",
      { request_id, value: { key: "business.phone", value: { e164: "0" } } },
    ],
    ["blank text", { request_id, value: "  " }],
    [
      "text over the cap",
      { request_id, value: "a".repeat(ANSWER_TEXT_MAX + 1) },
    ],
    [
      "an assignment id",
      { ...(samples.AnswerQuestionInput as object), assignment_id: request_id },
    ],
  ])("refuses %s", (_name, input) => {
    expect(verdict("AnswerQuestionInput", AnswerQuestionInput, input)).toEqual(
      REFUSED
    )
  })
})

describe("CosToolResult", () => {
  // The branches are written out, so each is checked against its tool.
  it("has one branch per tool, each with that tool's output", () => {
    const branches = CosToolResult.options.map((o) => o.shape)
    expect(branches.map((b) => b.tool.value)).toStrictEqual(
      Object.keys(COS_TOOLS)
    )
    for (const b of branches) {
      expect(b.output).toBe(COS_TOOLS[b.tool.value].output)
    }
  })

  it("refuses one tool's output under another tool's name", () => {
    const crossed = { ...(samples.CosToolResult as object), tool: "get_facts" }
    expect(verdict("CosToolResult", CosToolResult, crossed)).toEqual(REFUSED)
  })
})

describe("GetPreviewOutput", () => {
  it.each([
    ["a ready preview", samples.GetPreviewOutput],
    [
      "a refusal",
      {
        outcome: "refused",
        error: {
          class: "validation",
          code: "preview.not_ready",
          message: "This build has no preview yet.",
        },
      },
    ],
  ])("accepts %s", (_name, output) => {
    expect(verdict("GetPreviewOutput", GetPreviewOutput, output)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    [
      "a ready preview with a link",
      { ...(samples.GetPreviewOutput as object), url: "https://example.com" },
    ],
    ["a refusal with no error", { outcome: "refused" }],
  ])("refuses %s", (_name, output) => {
    expect(verdict("GetPreviewOutput", GetPreviewOutput, output)).toEqual(
      REFUSED
    )
  })
})

describe("CosWorkspace", () => {
  const workspace = samples.CosWorkspace as {
    questions: Record<string, unknown>[]
    approvals: unknown[]
  }
  const [question] = workspace.questions
  const withQuestion = (over: object) => ({
    ...workspace,
    questions: [{ ...question, ...over }],
  })

  it("accepts a workspace with no domains field", () => {
    const { domains: _domains, ...before } = samples.CosWorkspace as {
      domains: unknown
    }
    expect(verdict("CosWorkspace", CosWorkspace, before)).toEqual(ACCEPTED)
  })

  it("refuses eleven domains", () => {
    const [domain] = (samples.CosWorkspace as { domains: unknown[] }).domains
    expect(
      verdict("CosWorkspace", CosWorkspace, {
        ...workspace,
        domains: Array(11).fill(domain),
      })
    ).toEqual(REFUSED)
  })

  it.each([
    ["a why at the cap", withQuestion({ why: "a".repeat(500) })],
    [
      "ten options at the answer cap",
      withQuestion({ options: Array(10).fill("a".repeat(ANSWER_TEXT_MAX)) }),
    ],
  ])("accepts %s", (_name, value) => {
    expect(verdict("CosWorkspace", CosWorkspace, value)).toEqual(ACCEPTED)
  })

  it.each([
    ["a why over the cap", withQuestion({ why: "a".repeat(501) })],
    ["eleven options", withQuestion({ options: Array(11).fill("Weekly") })],
    [
      "an option over the answer cap",
      withQuestion({ options: ["a".repeat(ANSWER_TEXT_MAX + 1)] }),
    ],
    ["a blank option", withQuestion({ options: ["  "] })],
    ["eleven questions", { ...workspace, questions: Array(11).fill(question) }],
    [
      "eleven approvals",
      { ...workspace, approvals: Array(11).fill(workspace.approvals[0]) },
    ],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CosWorkspace", CosWorkspace, value)).toEqual(REFUSED)
  })
})

describe("the refusal a tool shows the model", () => {
  const refusal = {
    outcome: "refused",
    error: {
      class: "validation",
      code: "change.question_open",
      message: "Answer the open question first.",
    },
  }

  it.each([
    ["RequestChangeOutput", RequestChangeOutput],
    ["AnswerQuestionOutput", AnswerQuestionOutput],
    ["GetPreviewOutput", GetPreviewOutput],
    ["CreateReminderOutput", CreateReminderOutput],
    ["RecordReviewOutput", RecordReviewOutput],
  ] as const)("%s takes code, class and message only", (name, schema) => {
    expect(verdict(name, schema, refusal)).toEqual(ACCEPTED)
    const leaky = {
      ...refusal,
      error: { ...refusal.error, detail: { org_id: "o", url: "https://x" } },
    }
    expect(verdict(name, schema, leaky)).toEqual(REFUSED)
    const long = {
      ...refusal,
      error: { ...refusal.error, message: "a".repeat(501) },
    }
    expect(verdict(name, schema, long)).toEqual(REFUSED)
  })
})

// Beyond the checks every tool gets: a strict tool mode wants every input
// property required, and the output holds no id of any kind.
describe("create_reminder", () => {
  it("takes an object at its root", () => {
    const schema = z.toJSONSchema(CreateReminderRequest) as Record<
      string,
      unknown
    >
    expect(schema.type).toBe("object")
    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).not.toHaveProperty("oneOf")
    expect(schema).not.toHaveProperty("allOf")
  })

  it("names every input property as required, for strict tool modes", () => {
    const schema = z.toJSONSchema(CreateReminderRequest) as {
      properties: object
      required: string[]
    }
    expect(new Set(schema.required)).toEqual(
      new Set(Object.keys(schema.properties))
    )
  })

  it("shows the model no id, URL or open object", () => {
    const { keys, formats, open } = walk(z.toJSONSchema(CreateReminderOutput), {
      keys: [],
      formats: [],
      open: 0,
    })
    expect(open).toBe(0)
    expect(keys.filter((k) => k === "id" || k.endsWith("_id"))).toEqual([])
    expect(formats.filter((f) => f === "uri")).toEqual([])
  })

  it("refuses an output that carries the reminder's id", () => {
    const withId = {
      ...(samples.CreateReminderOutput as object),
      id: "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e",
    }
    expect(
      verdict("CreateReminderOutput", CreateReminderOutput, withId)
    ).toEqual(REFUSED)
  })
})

describe("record_review", () => {
  const review = samples.RecordReviewInput as Record<string, unknown>

  it("takes an object at its root, every property required", () => {
    const schema = z.toJSONSchema(RecordReviewInput) as {
      type: string
      properties: object
      required: string[]
    }
    expect(schema.type).toBe("object")
    expect(new Set(schema.required)).toEqual(
      new Set(Object.keys(schema.properties))
    )
  })

  it.each([
    ["no permission", { ...review, permission: false }],
    ["a missing permission", { ...review, permission: undefined }],
    ["a third slot", { ...review, slot: 3 }],
    ["a blank name", { ...review, name: "  " }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("RecordReviewInput", RecordReviewInput, value)).toEqual(
      REFUSED
    )
  })

  it("stores as the fact for its slot", () => {
    const { slot, ...value } = review
    expect(
      FactValue.parse({ key: `testimonials.review_${slot}`, value })
    ).toEqual({ key: "testimonials.review_1", value })
  })
})

describe("CosTurn", () => {
  const fallback = samples.CosTurn as Record<string, unknown>
  const { reason: _, ...ran } = fallback
  const turn_id = fallback.turn_id

  it.each([
    ["an answered turn", { ...ran, outcome: "answered", first_chunk_ms: 850 }],
    [
      "an abandoned turn",
      { outcome: "abandoned", turn_id, logged_usd: 0.002, reserved_usd: 0.008 },
    ],
  ])("accepts %s", (_name, turn) => {
    expect(verdict("CosTurn", CosTurn, turn)).toEqual(ACCEPTED)
  })

  it.each([
    ["a fallback with no reason", ran],
    ["a reason on an answered turn", { ...fallback, outcome: "answered" }],
    [
      "an abandoned turn with no reservation",
      { outcome: "abandoned", turn_id, logged_usd: 0 },
    ],
    ["more than six steps", { ...fallback, steps: 7 }],
    ["a tool it does not have", { ...fallback, tools: ["publish"] }],
  ])("refuses %s", (_name, turn) => {
    expect(verdict("CosTurn", CosTurn, turn)).toEqual(REFUSED)
  })
})

describe("CosFeedback", () => {
  const feedback = samples.CosFeedback as Record<string, unknown>

  it("accepts a rating of one message in one conversation", () => {
    expect(verdict("CosFeedback", CosFeedback, feedback)).toEqual(ACCEPTED)
  })

  it.each([
    ["no conversation", { ...feedback, conversation_id: undefined }],
    [
      "a conversation that is not a UUID",
      { ...feedback, conversation_id: "c1" },
    ],
    ["another rating", { ...feedback, rating: "positive" }],
    // No free text, so the event needs no taint label.
    ["a note", { ...feedback, note: "Wrong hours" }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CosFeedback", CosFeedback, value)).toEqual(REFUSED)
  })
})
