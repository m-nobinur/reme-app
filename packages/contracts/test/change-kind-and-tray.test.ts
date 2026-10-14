import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  AskDesignInput,
  AskDesignOutput,
  ChatRequest,
  RequestChangeOutput,
} from "../src/chat.ts"
import {
  BuildSummary,
  ChangeKind,
  OwnerChangeRequest,
  WorkspaceStatus,
} from "../src/owner.ts"
import { samples } from "./samples.ts"

const sample = <T>(name: keyof typeof samples) =>
  structuredClone(samples[name]) as T
type Obj = Record<string, unknown>

/** Every object in a recorded file, whatever wraps it: one JSON document, or JSON lines. */
function objectsIn(path: string): Obj[] {
  const text = readFileSync(new URL(path, import.meta.url), "utf8")
  const docs: unknown[] = path.endsWith(".jsonl")
    ? text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [JSON.parse(text)]
  const found: Obj[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (typeof node === "object" && node !== null) {
      found.push(node as Obj)
      Object.values(node).forEach(walk)
    }
  }
  docs.forEach(walk)
  return found
}

describe("ChangeKind on OwnerChangeRequest", () => {
  it("takes each kind", () => {
    for (const change_kind of [
      "copy",
      "style",
      "section",
      "photo",
      "creative",
    ]) {
      expect(
        OwnerChangeRequest.safeParse({
          text: "Change the hero title",
          change_kind,
        }).success,
        change_kind
      ).toBe(true)
    }
    expect(ChangeKind.options).toHaveLength(5)
  })

  it("still takes a request with no kind, which an old client sends", () => {
    const parsed = OwnerChangeRequest.parse({ text: "Change the hero title" })
    expect(parsed.change_kind).toBeUndefined()
  })

  it("refuses a kind nobody defined, an empty one, or a stray key", () => {
    for (const change_kind of ["typo", "", null, 3]) {
      expect(
        OwnerChangeRequest.safeParse({ text: "x", change_kind }).success
      ).toBe(false)
    }
    expect(
      OwnerChangeRequest.safeParse({ text: "x", kind: "copy" }).success
    ).toBe(false)
  })

  it("describes every kind in the tool schema, where the model reads it", () => {
    const schema = z.toJSONSchema(OwnerChangeRequest, {
      target: "draft-2020-12",
    }) as unknown as { properties: { change_kind: { description?: string } } }
    const text = schema.properties.change_kind.description ?? ""
    for (const kind of ChangeKind.options) {
      expect(text, kind).toContain(`${kind}:`)
    }
  })

  it("leaves the field out of required, so a strict reader of the schema still takes the old call", () => {
    const schema = z.toJSONSchema(OwnerChangeRequest, {
      target: "draft-2020-12",
    }) as unknown as { required: string[] }
    expect(schema.required).toEqual(["text"])
  })
})

/**
 * Recorded Chief of Staff turns: what the provider really sent for
 * `request_change`, and what the api answered. A new field that broke either
 * would break a conversation already stored.
 */
describe("recorded CoS fixtures", () => {
  // The staging turn records only the tool prefix, no request_change call.
  const files = [
    "../../../apps/api/test/cos-recorded-turn.json",
    "../../../evals/fixtures/cos-chat.jsonl",
  ]

  it.each(files)("%s: every request_change call still parses", (file) => {
    const inputs = objectsIn(file).filter(
      (o) => o.toolName === "request_change" && "input" in o
    )
    expect(inputs.length).toBeGreaterThan(0)
    for (const call of inputs) {
      expect(OwnerChangeRequest.safeParse(call.input).success).toBe(true)
    }
  })

  it("every request_change result in the recorded turn still parses", () => {
    const objects = objectsIn(files[0] as string)
    const calls = new Set(
      objects
        .filter((o) => o.toolName === "request_change")
        .map((o) => o.toolCallId)
    )
    const outputs = objects.filter(
      (o) => o.type === "tool-output-available" && calls.has(o.toolCallId)
    )
    expect(outputs.length).toBeGreaterThan(0)
    for (const result of outputs) {
      expect(RequestChangeOutput.safeParse(result.output).success).toBe(true)
    }
  })

  it("takes a recorded started build and the same build in the quick lane", () => {
    const started = sample<Obj>("RequestChangeOutput")
    const build = started.build as Obj
    expect(RequestChangeOutput.safeParse(started).success).toBe(true)
    expect(
      RequestChangeOutput.safeParse({
        ...started,
        build: { ...build, lane: "quick" },
      }).success
    ).toBe(true)
  })
})

describe("AskDesignInput", () => {
  const input = sample<{ questions: Obj[] }>("AskDesignInput")
  const [first] = input.questions as [Obj, ...Obj[]]

  it("parses the sample", () => {
    expect(AskDesignInput.parse(input)).toEqual(input)
  })

  it("takes each visual", () => {
    for (const visual of ["palette", "font_pair", "layout", "text"]) {
      expect(
        AskDesignInput.safeParse({ questions: [{ ...first, visual }] }).success,
        visual
      ).toBe(true)
    }
  })

  it("refuses no questions, nine, an unknown visual, a bad id, a stray key", () => {
    const cases: unknown[] = [
      { questions: [] },
      { questions: Array.from({ length: 9 }, () => first) },
      { questions: [{ ...first, visual: "mood_board" }] },
      { questions: [{ ...first, id: "Palette" }] },
      { questions: [{ ...first, id: "1st" }] },
      { questions: [{ ...first, extra: true }] },
      { questions: [{ id: first.id, visual: first.visual }] },
      { ...input, skippable: true },
    ]
    for (const candidate of cases) {
      expect(AskDesignInput.safeParse(candidate).success).toBe(false)
    }
  })

  it("keeps every rule of the ordinary choice card on each question", () => {
    const card = first.card as Obj
    const bad = { ...card, initial: ["not_offered", "a", "b"] }
    expect(
      AskDesignInput.safeParse({ questions: [{ ...first, card: bad }] }).success
    ).toBe(false)
    expect(
      AskDesignInput.safeParse({
        questions: [{ ...first, card: { ...card, options: [] } }],
      }).success
    ).toBe(false)
  })
})

describe("AskDesignOutput", () => {
  const ok = (value: unknown) => AskDesignOutput.safeParse(value).success

  it("takes a choice, the owner's own words and a skip, side by side", () => {
    expect(
      ok({
        answers: {
          palette: { choice: "forest" },
          typeface: { own: "Something rounder" },
          layout: { skipped: true },
        },
        skip_all: false,
      })
    ).toBe(true)
  })

  it("takes skip all with nothing answered, and some answered with skip all", () => {
    expect(ok({ answers: {}, skip_all: true })).toBe(true)
    expect(
      ok({ answers: { palette: { choice: "forest" } }, skip_all: true })
    ).toBe(true)
  })

  it("refuses an answer that is two things, none, or a skip that is false", () => {
    for (const answer of [
      { choice: "forest", own: "teal-ish" },
      {},
      { skipped: false },
      { choice: "" },
      { own: "   " },
      { choice: "forest", skipped: true },
    ]) {
      expect(
        ok({ answers: { palette: answer }, skip_all: false }),
        JSON.stringify(answer)
      ).toBe(false)
    }
  })

  it("refuses an answer keyed by something that is not a question id, and a missing skip_all", () => {
    expect(
      ok({ answers: { "Not An Id": { choice: "a" } }, skip_all: false })
    ).toBe(false)
    expect(ok({ answers: { "": { choice: "a" } }, skip_all: false })).toBe(
      false
    )
    expect(ok({ answers: {} })).toBe(false)
    expect(ok({ answers: {}, skip_all: false, extra: 1 })).toBe(false)
  })

  it("is an answer a chat turn can carry for the call it resolves", () => {
    const request = sample<{ turn: { results: Obj[] } }>("ChatRequest")
    const answer = {
      kind: "answer",
      tool_call_id: "call_5Hn2Wq8E",
      output: sample("AskDesignOutput"),
    }
    request.turn.results = [answer]
    expect(ChatRequest.safeParse(request).success).toBe(true)
  })
})

describe("lane and activity on a build", () => {
  const build = sample<Obj>("BuildSummary")

  it("takes each lane, and a build with neither field", () => {
    for (const lane of ["full", "quick"]) {
      expect(BuildSummary.safeParse({ ...build, lane }).success, lane).toBe(
        true
      )
    }
    const { lane: _lane, activity: _activity, ...old } = build
    expect(BuildSummary.safeParse(old).success).toBe(true)
  })

  it("refuses a lane nobody runs", () => {
    for (const lane of ["slow", "", null]) {
      expect(BuildSummary.safeParse({ ...build, lane }).success).toBe(false)
    }
  })

  it("holds at most five activity rows", () => {
    const row = (n: number) => ({
      id: `step_${n}`,
      label: `Step ${n}`,
      done: 0,
      total: 1,
    })
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i))
    expect(
      BuildSummary.safeParse({ ...build, activity: rows(5) }).success
    ).toBe(true)
    expect(
      BuildSummary.safeParse({ ...build, activity: rows(6) }).success
    ).toBe(false)
    expect(BuildSummary.safeParse({ ...build, activity: [] }).success).toBe(
      true
    )
  })

  it("refuses a row with no label, a negative count, a zero total, a bad id or a stray key", () => {
    const row = { id: "pages", label: "Writing the pages", done: 3, total: 5 }
    const bad: Obj[] = [
      { ...row, label: "" },
      { ...row, done: -1 },
      { ...row, total: 0 },
      { ...row, done: 1.5 },
      { ...row, id: "Pages" },
      { ...row, percent: 60 },
    ]
    for (const candidate of bad) {
      expect(
        BuildSummary.safeParse({ ...build, activity: [candidate] }).success
      ).toBe(false)
    }
  })
})

describe("expected seconds on the workspace", () => {
  const workspace = sample<Obj>("WorkspaceStatus")
  const expected = workspace.expected_seconds as Record<
    string,
    { p50: number; p95: number }
  >

  it("gives each lane a median no higher than its p95, in the sample", () => {
    for (const lane of ["full", "quick"]) {
      const { p50, p95 } = expected[lane] as { p50: number; p95: number }
      expect(p50, lane).toBeLessThanOrEqual(p95)
    }
  })

  it("parses with it, and without it, which is what the api sends today", () => {
    expect(WorkspaceStatus.safeParse(workspace).success).toBe(true)
    const { expected_seconds: _expected, ...today } = workspace
    expect(WorkspaceStatus.safeParse(today).success).toBe(true)
  })

  it("refuses a lane left out, a zero, a fraction and a third lane", () => {
    const parses = (value: unknown) =>
      WorkspaceStatus.safeParse({ ...workspace, expected_seconds: value })
        .success
    const full = expected.full
    const quick = expected.quick
    expect(parses({ full })).toBe(false)
    expect(parses({ full, quick: { p50: 0, p95: 45 } })).toBe(false)
    expect(parses({ full, quick: { p50: 20.5, p95: 45 } })).toBe(false)
    expect(parses({ full, quick: { p50: 20 } })).toBe(false)
    expect(parses({ full, quick, instant: quick })).toBe(false)
  })
})
