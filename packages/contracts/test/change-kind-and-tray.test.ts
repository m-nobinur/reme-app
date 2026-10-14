import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  AskDesignInput,
  AskDesignOutput,
  BlueprintReviewInput,
  BlueprintReviewOutput,
  ChatRequest,
  RequestChangeOutput,
} from "../src/chat.ts"
import { SectionVariant } from "../src/design.ts"
import {
  BuildSummary,
  ChangeKind,
  OwnerChangeRequest,
  PHOTO_PATH,
  thumbnailOf,
  WorkspaceStatus,
} from "../src/owner.ts"
import { ModelRoute } from "../src/runtime.ts"
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

  it("carries a plan for the Blueprint card, and refuses one that is not a Blueprint", () => {
    const blueprint = {
      plan: sample("Blueprint"),
      round: 1,
      previous: null,
      awaiting: true,
    }
    expect(BuildSummary.safeParse({ ...build, blueprint }).success).toBe(true)
    expect(
      BuildSummary.safeParse({
        ...build,
        blueprint: { ...blueprint, plan: { direction: "x" } },
      }).success
    ).toBe(false)
    expect(
      BuildSummary.safeParse({
        ...build,
        blueprint: { ...blueprint, round: 0 },
      }).success
    ).toBe(false)
  })

  it("carries the photos as they settle, each thumbnail on the app's own photo door", () => {
    const file = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"
    const photos = [
      {
        slot_id: "hero",
        state: "made",
        alt: "A van",
        thumbnail: `/api/photos/${file}`,
      },
      { slot_id: "about", state: "fallback", alt: null, thumbnail: null },
      { slot_id: "team", state: "drawing", alt: "The team", thumbnail: null },
    ]
    const at = (thumbnail: unknown) =>
      BuildSummary.safeParse({
        ...build,
        photos: [{ ...photos[0], thumbnail }],
        review_ms: 0,
      }).success
    expect(
      BuildSummary.safeParse({ ...build, photos, review_ms: 42_000 }).success
    ).toBe(true)
    expect(at(`https://evil.example/${file}`)).toBe(false)
    expect(at(`/api/photos/../${file}`)).toBe(false)
    expect(at(`/api/photos/${file}.svg`)).toBe(false)
    expect(at(`/api/photos/${file.toUpperCase()}`)).toBe(false)
    expect(BuildSummary.safeParse({ ...build, review_ms: -1 }).success).toBe(
      false
    )
    expect(
      BuildSummary.safeParse({
        ...build,
        photos: [{ ...photos[0], state: "done" }],
      }).success
    ).toBe(false)
  })

  it("names a thumbnail by the photo's asset id, and none without one", () => {
    const id = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"
    expect(thumbnailOf(id)).toBe(`/api/photos/${id}`)
    expect(`/photos/${id}`.replace(PHOTO_PATH, "$1")).toBe(id)
    for (const bad of [
      `${id}.png`,
      `../${id}`,
      "not-an-id",
      "",
      null,
      undefined,
    ]) {
      expect(thumbnailOf(bad), String(bad)).toBeNull()
    }
    expect(PHOTO_PATH.test(`/photos/${id}/x`)).toBe(false)
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
      { ...row, items: [{ label: "", done: true }] },
      { ...row, items: Array(10).fill({ label: "Home", done: false }) },
    ]
    const named = { ...row, items: [{ label: "Home", done: true }] }
    expect(
      BuildSummary.safeParse({ ...build, activity: [named] }).success
    ).toBe(true)
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

describe("BlueprintReview", () => {
  const input = sample<{ blueprint: Obj }>("BlueprintReviewInput")
  const okIn = (v: unknown) => BlueprintReviewInput.safeParse(v).success
  const okOut = (v: unknown) => BlueprintReviewOutput.safeParse(v).success

  it("takes a plan with and without the assignment it revises", () => {
    expect(okIn(input)).toBe(true)
    expect(okIn({ blueprint: input.blueprint })).toBe(true)
  })

  it("refuses a bad plan, a bad revision id and extra keys", () => {
    expect(okIn({ blueprint: { ...input.blueprint, pages: [] } })).toBe(false)
    expect(okIn({ ...input, revision_of: "nope" })).toBe(false)
    expect(okIn({ ...input, extra: 1 })).toBe(false)
  })

  it("answers build, with or without a note, and change only with one", () => {
    expect(okOut({ decision: "build" })).toBe(true)
    expect(okOut({ decision: "build", note: "Looks good" })).toBe(true)
    expect(okOut({ decision: "change", note: "More photos" })).toBe(true)
    expect(okOut({ decision: "change" })).toBe(false)
    expect(okOut({ decision: "change", note: "   " })).toBe(false)
    expect(okOut({ decision: "build", note: "x".repeat(501) })).toBe(false)
    expect(okOut({ decision: "maybe" })).toBe(false)
  })

  it("is an answer a chat turn can carry", () => {
    const request = sample<{ turn: { results: Obj[] } }>("ChatRequest")
    request.turn.results = [
      {
        kind: "answer",
        tool_call_id: "call_5Hn2Wq8E",
        output: { decision: "build" },
      },
    ]
    expect(ChatRequest.safeParse(request).success).toBe(true)
  })
})

describe("ModelRoute effort", () => {
  const ok = (v: unknown) => ModelRoute.safeParse(v).success
  const base = { model: "small", max_output_tokens: 1024 }

  it("still parses a route signed before they existed", () => {
    expect(ok(base)).toBe(true)
  })

  it("takes each effort, refuses anything else, and has no second cap", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"])
      expect(ok({ ...base, effort }), effort).toBe(true)
    expect(ok({ ...base, effort: "extreme" })).toBe(false)
    expect(ok({ ...base, max_tokens: 4096 })).toBe(false)
  })
})

describe("AskDesign question text and ChoiceVisual shapes", () => {
  const card = (visual: unknown) => ({
    step: "font",
    options: [
      { id: "a", label: "A", hint: null, visual },
      { id: "b", label: "B", hint: null, visual: null },
    ],
    multiple: false,
    preselected: [],
    other: null,
    skippable: true,
  })
  const ok = (visual: unknown, question?: string) =>
    AskDesignInput.safeParse({
      questions: [
        {
          id: "typeface",
          ...(question === undefined ? {} : { question }),
          visual: "font_pair",
          card: card(visual),
        },
      ],
    }).success

  it("takes a question of at most 120 characters, and an old call without one", () => {
    expect(ok(null)).toBe(true)
    expect(ok(null, "Which type feels like you?")).toBe(true)
    expect(ok(null, "x".repeat(120))).toBe(true)
    expect(ok(null, "x".repeat(121))).toBe(false)
    expect(ok(null, "")).toBe(false)
  })

  it("parses font_pair and layout visuals, and the old ones", () => {
    expect(
      ok({ kind: "font_pair", display: "Fraunces", body: "Figtree" })
    ).toBe(true)
    expect(ok({ kind: "font", family: "Fraunces" })).toBe(true)
    const variant = SectionVariant.options[0]
    expect(ok({ kind: "layout", hero: variant, services: variant })).toBe(true)
  })

  it("refuses a layout with an unknown variant or a font pair missing a half", () => {
    expect(ok({ kind: "layout", hero: "nope", services: "nope" })).toBe(false)
    expect(ok({ kind: "font_pair", display: "Fraunces" })).toBe(false)
  })
})
