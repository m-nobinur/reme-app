import { describe, expect, expectTypeOf, it } from "vitest"
import { z } from "zod"
import {
  AnswerQuestionInput,
  COS_TOOLS,
  CosToolName,
  CosToolResult,
  CosTurn,
  type GetPreviewOutput,
} from "../src/cos.ts"
import { ANSWER_TEXT_MAX } from "../src/owner.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

const tools = Object.entries(COS_TOOLS)

/** Every property name and string format anywhere in a JSON Schema. */
function walk(node: unknown, found: { keys: string[]; formats: string[] }) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found)
  } else if (typeof node === "object" && node !== null) {
    const { properties, format } = node as Record<string, unknown>
    if (typeof properties === "object" && properties !== null) {
      found.keys.push(...Object.keys(properties))
    }
    if (typeof format === "string") found.formats.push(format)
    for (const value of Object.values(node)) walk(value, found)
  }
  return found
}

describe("COS_TOOLS", () => {
  it("names exactly the tools CosToolName lists", () => {
    expect(Object.keys(COS_TOOLS)).toStrictEqual(CosToolName.options)
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

  // The model never sees a tenancy id, and a signed link is a bearer
  // capability the tool UI fetches for itself.
  it.each(tools)(
    "%s shows the model no org id, staff id or URL",
    (_name, { output }) => {
      const { keys, formats } = walk(z.toJSONSchema(output), {
        keys: [],
        formats: [],
      })
      expect(
        keys.filter((k) => k === "org_id" || k.endsWith("_staff_id"))
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
  // The branches come from a cast over COS_TOOLS, so the cast is checked.
  it("types each branch's output by its tool", () => {
    expectTypeOf<
      Extract<CosToolResult, { tool: "get_preview" }>["output"]
    >().toEqualTypeOf<GetPreviewOutput>()
  })

  it("refuses one tool's output under another tool's name", () => {
    const crossed = { ...(samples.CosToolResult as object), tool: "get_facts" }
    expect(verdict("CosToolResult", CosToolResult, crossed)).toEqual(REFUSED)
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
