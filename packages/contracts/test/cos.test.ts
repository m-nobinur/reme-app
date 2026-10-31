import { describe, expect, it } from "vitest"
import { z } from "zod"
import { RequestChangeOutput } from "../src/chat.ts"
import {
  AnswerQuestionInput,
  AnswerQuestionOutput,
  AskDeveloperInput,
  AskDeveloperOutput,
  COS_TOOLS,
  CosApproval,
  CosCompaction,
  CosContext,
  CosFeedback,
  CosMessage,
  CosToolName,
  CosToolResult,
  CosToolStarted,
  CosToolUnknown,
  CosTurn,
  CosWorkspace,
  CreateReminderOutput,
  GetChangeInput,
  GetChangeOutput,
  GetReviewInput,
  GetReviewOutput,
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
  it("has exactly the twenty-five tools, in order", () => {
    const all = [
      "get_workspace",
      "get_facts",
      "get_change",
      "request_change",
      "answer_question",
      "create_reminder",
      "update_reminder",
      "delete_reminder",
      "set_time_zone",
      "record_review",
      "check_domain",
      "connect_domain",
      "remove_domain",
      "find_domain",
      "buy_domain",
      "connect_google",
      "get_search_performance",
      "get_indexing",
      "remember",
      "put_off",
      "inspect_domain",
      "domain_bought",
      "offer_grant",
      "read_skill",
      "save_correction",
      "schedule_skill",
    ]
    expect(Object.keys(COS_TOOLS)).toStrictEqual(all)
    expect(CosToolName.options).toStrictEqual(all)
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
  it("has one branch per tool, each with that tool's output, then the retired get_preview", () => {
    const branches = CosToolResult.options.map((o) => o.shape)
    expect(branches.map((b) => b.tool.value)).toStrictEqual([
      ...Object.keys(COS_TOOLS),
      "get_preview",
    ])
    for (const b of branches.slice(0, -1)) {
      expect(b.output).toBe(COS_TOOLS[b.tool.value as CosToolName].output)
    }
  })

  it("refuses one tool's output under another tool's name", () => {
    const crossed = { ...(samples.CosToolResult as object), tool: "get_facts" }
    expect(verdict("CosToolResult", CosToolResult, crossed)).toEqual(REFUSED)
  })
})

describe("a turn logged before get_change replaced get_preview", () => {
  const preview = {
    outcome: "ready",
    assignment_id: "3c4d5e6f-7081-4c8d-9e0f-3a4b5c6d7e8f",
    version: 3,
    expires_at: "2026-08-27T09:30:00+01:00",
  }

  it("replays its get_preview result", () => {
    const logged = {
      ...(samples.CosToolResult as object),
      tool_call_id: "functions.get_preview:0",
      tool: "get_preview",
      output: preview,
    }
    expect(verdict("CosToolResult", CosToolResult, logged)).toEqual(ACCEPTED)
    expect(
      verdict("CosToolResult", CosToolResult, {
        ...logged,
        output: { ...preview, url: "https://example.com" },
      })
    ).toEqual(REFUSED)
  })

  it.each([
    [
      "CosContext",
      CosContext,
      { ...(samples.CosContext as object), active_tools: ["get_preview"] },
    ],
    [
      "CosTurn",
      CosTurn,
      { ...(samples.CosTurn as object), tools: ["get_preview"] },
    ],
  ] as const)("replays a %s that names it", (name, schema, value) => {
    expect(verdict(name, schema, value)).toEqual(ACCEPTED)
  })

  it("is no tool the CoS can call", () => {
    expect(CosToolName.safeParse("get_preview").success).toBe(false)
  })
})

describe("GetChangeOutput", () => {
  const found = samples.GetChangeOutput as Record<string, unknown>
  const pair = { before: "a", after: "b", pages: ["/"] }

  it.each([
    ["a found change", found],
    [
      "a change from before text changes were recorded",
      (({ text_changes: _t, ...rest }) => ({ ...rest, recorded: false }))(
        found
      ),
    ],
    [
      "eight pairs and a count left",
      { ...found, text_changes: Array(8).fill(pair), text_changes_left: 4 },
    ],
    ["no change yet", { outcome: "none" }],
  ])("accepts %s", (_name, output) => {
    expect(verdict("GetChangeOutput", GetChangeOutput, output)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["nine pairs", { ...found, text_changes: Array(9).fill(pair) }],
    [
      "six recent changes",
      { ...found, recent: Array(6).fill((found.recent as unknown[])[0]) },
    ],
    [
      "eleven left out",
      { ...found, left_out: Array(11).fill("What are your prices?") },
    ],
    ["a done over 500", { ...found, done: "a".repeat(501) }],
    ["an org id", { ...found, org_id: found.ref }],
  ])("refuses %s", (_name, output) => {
    expect(verdict("GetChangeOutput", GetChangeOutput, output)).toEqual(REFUSED)
  })

  it.each([
    ["no ref", {}, ACCEPTED],
    ["a ref", samples.GetChangeInput, ACCEPTED],
    ["an assignment id", { assignment_id: found.ref }, REFUSED],
  ])("input with %s", (_name, input, expected) => {
    expect(verdict("GetChangeInput", GetChangeInput, input)).toEqual(expected)
  })
})

describe("ask_developer", () => {
  const input = samples.AskDeveloperInput as Record<string, unknown>
  const answered = samples.AskDeveloperOutput as Record<string, unknown>
  const REF = "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e"

  it.each([
    ["a question", input],
    ["a review with no pages", { mode: "review", question: "Check my site" }],
  ])("accepts %s as input", (_name, value) => {
    expect(verdict("AskDeveloperInput", AskDeveloperInput, value)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["a blank question", { ...input, question: "   " }],
    ["a question over 500", { ...input, question: "a".repeat(501) }],
    ["six pages", { ...input, pages: Array(6).fill("/") }],
    ["another mode", { ...input, mode: "fix" }],
  ])("refuses %s as input", (_name, value) => {
    expect(verdict("AskDeveloperInput", AskDeveloperInput, value)).toEqual(
      REFUSED
    )
  })

  it.each([
    ["an answer", answered],
    ["a review started", { outcome: "review_started", ref: REF, seconds: 90 }],
    ["a review running", { outcome: "review_running", ref: REF }],
    ["no site", { outcome: "no_site" }],
  ])("accepts %s", (_name, value) => {
    expect(verdict("AskDeveloperOutput", AskDeveloperOutput, value)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["an answer over 1200", { ...answered, answer: "a".repeat(1201) }],
    [
      "seven sources",
      { ...answered, sources: Array(7).fill({ kind: "page", ref: "/" }) },
    ],
    [
      "a review taking no time",
      { outcome: "review_started", ref: REF, seconds: 0 },
    ],
  ])("refuses %s", (_name, value) => {
    expect(verdict("AskDeveloperOutput", AskDeveloperOutput, value)).toEqual(
      REFUSED
    )
  })
})

describe("get_review", () => {
  const found = samples.GetReviewOutput as Record<string, unknown>

  it.each([
    ["a stored review", found],
    ["a review still running", { outcome: "running", ref: found.review_id }],
    ["no review", { outcome: "none" }],
  ])("accepts %s", (_name, value) => {
    expect(verdict("GetReviewOutput", GetReviewOutput, value)).toEqual(ACCEPTED)
  })

  it("refuses a review that shows the model its org", () => {
    expect(
      verdict("GetReviewOutput", GetReviewOutput, {
        ...found,
        org_id: found.review_id,
      })
    ).toEqual(REFUSED)
  })

  it.each([
    ["no ref", {}],
    ["a ref", samples.GetReviewInput],
  ])("takes %s", (_name, value) => {
    expect(verdict("GetReviewInput", GetReviewInput, value)).toEqual(ACCEPTED)
  })
})

describe("CosWorkspace", () => {
  it("replays a workspace read stored before builds carried progress and stops", () => {
    const {
      stopped: _stopped,
      builds,
      ...rest
    } = samples.CosWorkspace as {
      stopped: unknown
      builds: { progress?: unknown }[]
    }
    const stored = {
      ...rest,
      builds: builds.map(({ progress: _progress, ...build }) => build),
    }
    expect(verdict("CosWorkspace", CosWorkspace, stored)).toEqual(ACCEPTED)
  })

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
    ["GetChangeOutput", GetChangeOutput],
    ["AskDeveloperOutput", AskDeveloperOutput],
    ["GetReviewOutput", GetReviewOutput],
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
// property required, and the output's only id is the reminder's own ref,
// which update_reminder and delete_reminder take back.
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

  it("shows the model no id but its own ref, no URL and no open object", () => {
    // The api drops evidence's ids before the model reads a result.
    const shown = z.toJSONSchema(CreateReminderOutput, {
      override: ({ jsonSchema }) => {
        delete jsonSchema.properties?.evidence
      },
    })
    const { keys, formats, open } = walk(shown, {
      keys: [],
      formats: [],
      open: 0,
    })
    expect(open).toBe(0)
    expect(
      keys.filter(
        (k) => (k === "id" || k.endsWith("_id")) && k !== "reminder_id"
      )
    ).toEqual([])
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
      "a card click's turn",
      { ...ran, outcome: "answered", route: "card_click", first_chunk_ms: 640 },
    ],
    [
      "an abandoned turn",
      { outcome: "abandoned", turn_id, logged_usd: 0.002, reserved_usd: 0.008 },
    ],
    ["a stopped turn", { ...ran, outcome: "stopped" }],
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
    ["a route the table does not have", { ...fallback, route: "router" }],
  ])("refuses %s", (_name, turn) => {
    expect(verdict("CosTurn", CosTurn, turn)).toEqual(REFUSED)
  })
})

describe("CosMessage", () => {
  const logged = samples.CosMessage as { message: Record<string, unknown> }
  const reply = {
    ...logged,
    message: {
      ...logged.message,
      role: "assistant",
      parts: [{ type: "text", text: "Checking" }],
    },
  }

  it.each([
    ["a message logged before the markers", reply],
    [
      "a stopped reply",
      { ...reply, message: { ...reply.message, stopped: true } },
    ],
    [
      "a partial reply",
      { ...reply, message: { ...reply.message, stopped: true, partial: true } },
    ],
  ])("accepts %s", (_name, value) => {
    expect(verdict("CosMessage", CosMessage, value)).toEqual(ACCEPTED)
  })

  it("refuses a marker that is not true", () => {
    expect(
      verdict("CosMessage", CosMessage, {
        ...reply,
        message: { ...reply.message, partial: false },
      })
    ).toEqual(REFUSED)
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

describe("CosApproval", () => {
  const approval = samples.CosApproval as Record<string, unknown>

  it("accepts a card bound to an input hash and an expiry", () => {
    expect(verdict("CosApproval", CosApproval, approval)).toEqual(ACCEPTED)
  })

  it.each([
    ["no input hash", { ...approval, input_sha256: undefined }],
    ["an input hash that is not sha-256", { ...approval, input_sha256: "abc" }],
    ["no expiry", { ...approval, expires_at: undefined }],
    ["an expiry with no offset", { ...approval, expires_at: "2026-08-27" }],
    ["a tool call id with a space", { ...approval, tool_call_id: "a b" }],
    // The hash binds the input; the input itself stays out of the event.
    ["the input itself", { ...approval, input: { title: "x" } }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CosApproval", CosApproval, value)).toEqual(REFUSED)
  })
})

describe("CosToolStarted", () => {
  const started = samples.CosToolStarted as Record<string, unknown>

  it("accepts a call and the approval it runs under", () => {
    expect(verdict("CosToolStarted", CosToolStarted, started)).toEqual(ACCEPTED)
  })

  it.each([
    ["no approval", { ...started, approval_id: undefined }],
    ["an empty call id", { ...started, tool_call_id: "" }],
    ["a time", { ...started, at: "2026-10-19T12:00:00Z" }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CosToolStarted", CosToolStarted, value)).toEqual(REFUSED)
  })
})

describe("CosToolUnknown", () => {
  const unknown = samples.CosToolUnknown as Record<string, unknown>

  it("accepts a call and the approval it ran under", () => {
    expect(verdict("CosToolUnknown", CosToolUnknown, unknown)).toEqual(ACCEPTED)
  })

  it.each([
    ["no approval", { ...unknown, approval_id: undefined }],
    ["an empty call id", { ...unknown, tool_call_id: "" }],
    ["a reason", { ...unknown, reason: "timeout" }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CosToolUnknown", CosToolUnknown, value)).toEqual(REFUSED)
  })
})

describe("CosCompaction", () => {
  const compaction = samples.CosCompaction as Record<string, unknown>

  it("accepts a summary, the range it replaces and the refs it drops", () => {
    expect(verdict("CosCompaction", CosCompaction, compaction)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["a blank summary", { ...compaction, summary: " \n " }],
    ["no range", { ...compaction, replaced_range: undefined }],
    [
      "a negative range start",
      { ...compaction, replaced_range: { from_seq: -1, to_seq: 2 } },
    ],
    [
      "a ref that is not an event id",
      { ...compaction, dropped_refs: ["evt_1"] },
    ],
    ["no dropped refs", { ...compaction, dropped_refs: undefined }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CosCompaction", CosCompaction, value)).toEqual(REFUSED)
  })
})

describe("a slow read's step", () => {
  const STEPPED = {
    find_domain: samples.FindDomainInput,
    check_domain: samples.CheckDomainInput,
    inspect_domain: samples.InspectDomainInput,
    get_search_performance: samples.GetSearchPerformanceInput,
    get_indexing: samples.GetIndexingInput,
  } as const

  it.each(Object.entries(STEPPED))(
    "%s takes a step of 60 characters and refuses 61",
    (tool, sample) => {
      const { input } = COS_TOOLS[tool as keyof typeof STEPPED]
      const stepped = (step: string) =>
        input.safeParse({ ...(sample as object), step })
      expect(stepped("a".repeat(60)).success).toBe(true)
      expect(stepped("a".repeat(61)).success).toBe(false)
      expect(input.safeParse(sample).success).toBe(true)
    }
  )
})
