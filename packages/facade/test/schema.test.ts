import { CompletionReport, InformationRequest } from "@workspace/contracts"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { toolInput } from "../src/schema.ts"

/**
 * The seam's contract: for every fixture, zod and the derived valibot agree,
 * accepting and refusing the same inputs. A corpus rather than a proof, and
 * every tool input the Developer mounts is in it.
 */
const AskChief = InformationRequest.pick({
  field: true,
  why: true,
  answer_schema: true,
  options: true,
  blocking: true,
})

const ReportComplete = CompletionReport.pick({
  summary: true,
  changes: true,
  risks: true,
  decisions_needed: true,
})

const BatchEdit = z.strictObject({
  path: z.string().min(1),
  edits: z
    .array(z.strictObject({ oldText: z.string().min(1), newText: z.string() }))
    .min(1),
})

const corpus: { name: string; zod: z.ZodType; inputs: unknown[] }[] = [
  {
    name: "ask_chief",
    zod: AskChief,
    inputs: [
      {
        field: "business.phone",
        why: "The contact page has no number to show.",
        answer_schema: { type: "string" },
        options: null,
        blocking: true,
      },
      {
        field: "business.phone",
        why: "x",
        answer_schema: {},
        options: ["a", "b"],
        blocking: false,
      },
      { field: "", why: "x", answer_schema: {}, options: null, blocking: true },
      { field: "x", why: "x", answer_schema: {}, options: null },
      {
        field: "x",
        why: "x",
        answer_schema: {},
        options: null,
        blocking: true,
        extra: 1,
      },
      { field: 3, why: "x", answer_schema: {}, options: null, blocking: true },
    ],
  },
  {
    name: "report_complete",
    zod: ReportComplete,
    inputs: [
      {
        summary: "Built it.",
        changes: [{ path: "src/site-config.ts", reason: "filled the phone" }],
        risks: [],
        decisions_needed: [],
      },
      {
        summary: "Built it.",
        changes: [{ path: "../escape", reason: "no" }],
        risks: [],
        decisions_needed: [],
      },
      { summary: "Built it.", changes: [], risks: [], decisions_needed: [] },
      {
        summary: "",
        changes: [{ path: "a", reason: "b" }],
        risks: [],
        decisions_needed: [],
      },
    ],
  },
  {
    name: "capped list",
    zod: z.strictObject({
      options: z.array(z.string().min(1).max(3)).max(2).nullable(),
    }),
    inputs: [
      { options: ["a", "b"] },
      { options: ["a", "b", "c"] },
      { options: ["abcd"] },
      { options: null },
    ],
  },
  {
    name: "edit",
    zod: BatchEdit,
    inputs: [
      {
        path: "src/pages/index.astro",
        edits: [{ oldText: "a", newText: "b" }],
      },
      { path: "src/pages/index.astro", edits: [] },
      { path: "", edits: [{ oldText: "a", newText: "b" }] },
      { path: "x", edits: [{ oldText: "", newText: "b" }] },
      { path: "x", edits: [{ oldText: "a" }] },
    ],
  },
]

describe("the zod to valibot seam", () => {
  it.each(corpus)(
    "$name: both schemas agree on every input",
    ({ zod, inputs }) => {
      const valibot = toolInput(zod)
      for (const input of inputs) {
        const a = zod.safeParse(input).success
        const b = v.safeParse(valibot, input).success
        expect(b, JSON.stringify(input)).toBe(a)
      }
    }
  )

  it("takes a tool with no input (z.object({})) as an empty object, not a map", () => {
    const valibot = toolInput(z.object({}))
    expect(v.safeParse(valibot, {}).success).toBe(true)
    expect(v.safeParse(valibot, "x").success).toBe(false)
  })

  it("refuses a non-object input schema", () => {
    expect(() => toolInput(z.string())).toThrow(/object schema/)
  })
})
