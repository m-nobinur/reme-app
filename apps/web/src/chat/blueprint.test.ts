import {
  type Blueprint,
  BlueprintReviewOutput,
  ChatRequest,
  PALETTES,
} from "@workspace/contracts"
import {
  CHANGE_PREFIX,
  changedRows,
  generatedLine,
  paletteStops,
  waitsOnBlueprint,
} from "@workspace/ui/lib/blueprint"
import { blueprintReviewView } from "@workspace/ui/lib/tool-state"
import { describe, expect, it } from "vitest"
import type { ChatMessage } from "./message"
import { blueprintChanges, chatTurn, replyTo, sendsOn } from "./turn"

const section = (kind: string, variant: string) => ({
  kind,
  variant,
  purpose: "Made up",
  content_notes: null,
})
const photo = (id: string, source: "upload" | "generated") => ({
  id,
  page: "home",
  section: "hero",
  aspect: "16:9",
  resolution: "2K",
  subject: "A made-up room",
  alt: "A made-up room",
  source,
  ...(source === "upload"
    ? { asset_id: "00000000-0000-4000-8000-000000000001" }
    : {}),
})

/** A plan for a made-up business; nothing here is real. */
const BLUEPRINT = {
  direction: "calm_daylight",
  fonts: "outfit_figtree",
  palette: { kind: "preset", id: "mint" },
  pages: [
    {
      page: "home",
      sections: [section("hero", "wash"), section("faq", "split")],
    },
    { page: "quote", sections: [section("quote_form", "default")] },
  ],
  images: [
    photo("slot_a", "generated"),
    photo("slot_b", "generated"),
    photo("slot_c", "upload"),
  ],
  voice: "Plain and warm.",
  features: ["One", "Two", "Three", "Four"],
} as unknown as Blueprint

const REPLAN: Blueprint = {
  ...BLUEPRINT,
  palette: { kind: "preset", id: "pebble" },
  pages: [
    ...BLUEPRINT.pages,
    { page: "gallery", sections: [section("gallery", "default")] },
  ] as Blueprint["pages"],
  features: [...BLUEPRINT.features.slice(0, 3), "Five"],
}

const CONVERSATION = "7d1c2a4e-2f0b-4c8e-9a51-3b6f0e2d9c10"
type Part = ChatMessage["parts"][number]

const plan = (state: string, extra: object = {}) =>
  ({
    type: "tool-review_blueprint",
    toolCallId: "call_plan",
    state,
    input: { blueprint: BLUEPRINT },
    ...extra,
  }) as unknown as Part

const assistant = (...parts: Part[]): ChatMessage => ({
  id: "msg_assistant",
  role: "assistant",
  parts: [{ type: "step-start" }, ...parts],
})

describe("the plan card's view", () => {
  const args = { blueprint: BLUEPRINT }
  it("reads every state", () => {
    expect(blueprintReviewView({ args }).state).toBe("pending")
    expect(
      blueprintReviewView({ args, result: { decision: "build" } })
    ).toMatchObject({ state: "answered", output: { decision: "build" } })
    expect(
      blueprintReviewView({ args, isError: true, result: { error: "x" } }).state
    ).toBe("error")
    expect(blueprintReviewView({ args: { blueprint: {} } }).state).toBe("error")
    expect(
      blueprintReviewView({ args, result: { decision: "change" } }).state
    ).toBe("error")
  })

  it("tells the composer a plan waits", () => {
    const call = { type: "tool-call", toolName: "review_blueprint" }
    expect(waitsOnBlueprint([call])).toBe(true)
    expect(waitsOnBlueprint([{ ...call, result: { decision: "build" } }])).toBe(
      false
    )
    expect(waitsOnBlueprint([{ ...call, isError: true }])).toBe(false)
    expect(waitsOnBlueprint(undefined)).toBe(false)
  })
})

describe("the plan's turn", () => {
  it("sends Build it as the owner's reply, with the answer to its call", () => {
    const output = { decision: "build" as const }
    const waiting = [assistant(plan("input-available"))]
    const reply = replyTo(waiting, { toolCallId: "call_plan", output })
    expect(reply).toEqual({
      role: "user",
      parts: [{ type: "text", text: "Build it" }],
      metadata: { reply: true },
    })
    const answered = assistant(plan("output-available", { output }))
    expect(sendsOn({ messages: [answered] })).toBe(false)
    const sent = [answered, { ...(reply as ChatMessage), id: "msg_reply" }]
    expect(ChatRequest.parse(chatTurn(CONVERSATION, "act", sent)).turn).toEqual(
      {
        kind: "results",
        message_id: "msg_assistant",
        results: [{ kind: "answer", tool_call_id: "call_plan", output }],
        reply: { message_id: "msg_reply", text: "Build it" },
      }
    )
  })

  it("takes a typed message as the change, without the composer's prefix", () => {
    const waiting = [assistant(plan("input-available"))]
    const changes = blueprintChanges(
      waiting,
      `${CHANGE_PREFIX}add a gallery page `
    )
    expect(changes).toEqual({
      tool: "review_blueprint",
      toolCallId: "call_plan",
      output: { decision: "change", note: "add a gallery page" },
    })
    expect(blueprintChanges(waiting, "Add a gallery page")?.output).toEqual({
      decision: "change",
      note: "Add a gallery page",
    })
    const reply = replyTo(waiting, changes as NonNullable<typeof changes>)
    expect(reply).toEqual({
      role: "user",
      parts: [{ type: "text", text: "add a gallery page" }],
      metadata: { reply: true, typed: true },
    })
  })

  it("leaves alone a message with only the prefix, a site change, or no plan waiting", () => {
    const waiting = [assistant(plan("input-available"))]
    expect(blueprintChanges(waiting, CHANGE_PREFIX)).toBe(null)
    expect(blueprintChanges(waiting, "Add hours", "site_change")).toBe(null)
    expect(blueprintChanges(waiting, "x".repeat(501))).toBe(null)
    expect(blueprintChanges([assistant(plan("output-error"))], "Hello")).toBe(
      null
    )
  })

  it("keeps the contract's own change note rule", () => {
    expect(
      BlueprintReviewOutput.safeParse({ decision: "change", note: "" }).success
    ).toBe(false)
  })
})

describe("what the card says of a plan", () => {
  it("marks no row on a first plan and only the differing rows on a re-plan", () => {
    expect(changedRows(null, BLUEPRINT).size).toBe(0)
    expect([...changedRows(BLUEPRINT, REPLAN)].sort()).toEqual([
      "feature:Five",
      "page:gallery",
      "palette",
    ])
  })

  it("draws a preset's four colours and shades an own colour", () => {
    expect(paletteStops(BLUEPRINT.palette)).toHaveLength(4)
    const brand = PALETTES[0]?.brand ?? ""
    const stops = paletteStops({ kind: "brand", brand })
    expect(stops).toHaveLength(4)
    expect(stops[2]).toBe(brand)
  })

  it("says which photos are made and how many are the owner's", () => {
    expect(generatedLine(BLUEPRINT)).toBe(
      "2 photos will be made for you: Home hero, Home hero. 1 is yours."
    )
    const two = {
      ...BLUEPRINT,
      images: [
        ...BLUEPRINT.images,
        { ...BLUEPRINT.images[2], slot_id: "slot_d" },
      ],
    } as Blueprint
    expect(generatedLine(two)).toMatch(/2 are yours\.$/)
  })
})
