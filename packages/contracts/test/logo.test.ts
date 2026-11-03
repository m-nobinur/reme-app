import { describe, expect, it } from "vitest"
import {
  colourName,
  DrawLogosRequest,
  LogoChip,
  LogoRound,
  LogoSuggestion,
  PALETTES,
} from "../src/index.ts"
import colours from "../src/logo-colours.json" with { type: "json" }

const palette = PALETTES[0] as (typeof PALETTES)[number]
const brief = {
  description: "",
  colors: [palette.primary],
  type: "lockup",
  style: "minimal",
} as const

describe("the logo's suggested start", () => {
  it("takes three directions of three different types", () => {
    const three = [
      { type: "lockup", style: "hand_drawn" },
      { type: "icon", style: "geometric" },
      { type: "emblem", style: "retro" },
    ]
    expect(
      LogoSuggestion.safeParse({ directions: three, description: "" }).success
    ).toBe(true)
    const twice = [three[0], three[0], three[2]]
    expect(
      LogoSuggestion.safeParse({ directions: twice, description: "" }).success
    ).toBe(false)
  })

  it("draws directions only for a fresh round, never with a base", () => {
    const directions = [
      { type: "lockup", style: "hand_drawn" },
      { type: "icon", style: "geometric" },
      { type: "emblem", style: "retro" },
    ]
    const fresh = { tool_call_id: "call_1", brief, directions }
    expect(DrawLogosRequest.safeParse(fresh).success).toBe(true)
    expect(
      DrawLogosRequest.safeParse({
        ...fresh,
        changes: "bolder",
        base: "8d9e0f10-2131-4a2b-9c3d-4e5f60718293",
      }).success
    ).toBe(false)
  })
})

describe("a redesign chip", () => {
  it("has at most three words in its label", () => {
    const chip = {
      kind: "detail",
      label: "Bigger leaf",
      change: "a bigger leaf",
    }
    expect(LogoChip.safeParse(chip).success).toBe(true)
    expect(
      LogoChip.safeParse({ ...chip, label: "A much bigger leaf" }).success
    ).toBe(false)
  })

  it("comes at most once of each kind on a design", () => {
    const round = (chips: object[]) => ({
      round: 1,
      status: "ready",
      started_at: "2026-11-04T09:00:00Z",
      variants: [
        {
          id: "8d9e0f10-2131-4a2b-9c3d-4e5f60718293",
          direction: { type: "lockup", style: "minimal" },
          chips,
        },
      ],
      brief,
    })
    const bolder = { kind: "detail", label: "Bolder", change: "bolder shapes" }
    expect(LogoRound.safeParse(round([bolder])).success).toBe(true)
    expect(LogoRound.safeParse(round([bolder, bolder])).success).toBe(false)
  })
})

describe("a colour's plain name", () => {
  it("is one of the named colours", () => {
    for (const each of PALETTES) {
      expect(Object.keys(colours.names)).toContain(colourName(each.primary))
    }
  })
})
