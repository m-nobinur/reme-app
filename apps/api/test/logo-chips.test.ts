import { LogoChip, PALETTES } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  CATALOG,
  CHIP_QUESTIONS,
  changeSetsFrom,
  chipsFrom,
  colourChip,
  readChips,
  SEEN,
} from "../src/logo-chips.ts"

const reading = (score: number) => ({ score, confidence: 1 })
const palette = PALETTES[0] as (typeof PALETTES)[number]
const PRUNING = [
  { type: "lockup", style: "hand_drawn" },
  { type: "icon", style: "geometric" },
  { type: "emblem", style: "retro" },
] as const

describe("redesign chips for one design", () => {
  // Jev's answers on Pruning Co's retro emblem, measured on 2026-11-04.
  const emblem = {
    finer: reading(0.87),
    fewer_details: reading(0.73),
    bolder: reading(0.09),
    style_minimal: reading(0.55),
    style_hand_drawn: reading(0.31),
    style_geometric: reading(0.16),
    style_retro: reading(0.56),
    type_lockup: reading(0.66),
    type_icon: reading(0.59),
    type_emblem: reading(0.94),
  }

  it("keeps one of each kind: what Jev sees, another suggested style and type, and code's colour", () => {
    const chips = chipsFrom(
      emblem,
      { type: "emblem", style: "retro" },
      [palette.primary, palette.ink],
      PRUNING
    )
    expect(chips.map((c) => c.kind)).toEqual([
      "detail",
      "style",
      "type",
      "colour",
    ])
    expect(chips[0]).toMatchObject({ label: "Finer lines" })
    // Minimal scored higher on the picture, but the business was suggested hand-drawn.
    expect(chips[1]).toMatchObject({ set: { style: "hand_drawn" } })
    expect(chips[2]).toMatchObject({ set: { type: "lockup" } })
    for (const chip of chips)
      expect(LogoChip.safeParse(chip).success).toBe(true)
  })

  it("never offers the design's own style or type, nor a detail Jev does not see", () => {
    const chips = chipsFrom(
      { ...emblem, finer: reading(SEEN - 0.1), fewer_details: reading(0.2) },
      { type: "lockup", style: "hand_drawn" },
      [palette.primary],
      PRUNING
    )
    expect(chips.find((c) => c.kind === "detail")).toBeUndefined()
    expect(chips.map((c) => c.set?.style)).not.toContain("hand_drawn")
    expect(chips.map((c) => c.set?.type)).not.toContain("lockup")
  })

  it("suggests from every style and type when the round drew no directions", () => {
    const chips = chipsFrom(
      { ...emblem, style_luxury: reading(0.99), type_monogram: reading(0.99) },
      { type: "wordmark", style: "minimal" },
      [palette.primary]
    )
    expect(chips.map((c) => c.set?.style ?? c.set?.type)).toEqual([
      undefined,
      "luxury",
      "monogram",
      undefined,
    ])
  })

  it("darkens a light brand colour and lightens a dark one, keeping the rest", () => {
    const light = colourChip([palette.paper, palette.ink])
    expect(light?.label).toMatch(/^Darker /)
    expect(light?.set?.colors?.[1]).toBe(palette.ink)
    const dark = colourChip([palette.ink])
    expect(dark?.label).toMatch(/^Lighter /)
    expect(LogoChip.safeParse(dark).success).toBe(true)
  })

  it("only writes chips the tray can read: every catalog chip and colour chip passes LogoChip", () => {
    for (const { kind, label, change, set } of CATALOG) {
      const chip = { kind, label, change, ...(set ? { set } : {}) }
      expect(LogoChip.safeParse(chip), label).toMatchObject({ success: true })
    }
    const steps = [0, 51, 102, 153, 204, 255]
    const hexes = [
      ...PALETTES.flatMap((each) => each.swatches),
      ...steps.flatMap((r) =>
        steps.flatMap((g) =>
          steps.map(
            (b) =>
              `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`
          )
        )
      ),
    ]
    for (const hex of hexes) {
      const chip = colourChip([hex])
      expect(LogoChip.safeParse(chip), `${hex} ${chip?.label}`).toMatchObject({
        success: true,
      })
    }
  })

  it("asks Jev one question per catalog chip, with the picture last", async () => {
    expect(Object.keys(CHIP_QUESTIONS)).toEqual(CATALOG.map((e) => e.id))
    let body = ""
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = String(init.body)
      return new Response("{}", { status: 503 })
    }) as unknown as typeof fetch
    const chips = await readChips(
      "key",
      "Pruning Co",
      "data:image/jpeg;base64,AAAA",
      { type: "emblem", style: "retro" },
      {
        description: "",
        colors: [palette.primary],
        type: "emblem",
        style: "retro",
      },
      PRUNING,
      fetchImpl
    )
    // A failed call leaves the tray's own chips.
    expect(chips).toBeNull()
    const sent = JSON.parse(body)
    expect(Object.keys(sent)).toEqual(["model", "questions", "state"])
    expect(sent.state.logo).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AAAA" },
    })
  })
})

describe("typed changes read against the brief", () => {
  it("sets a type or style only when one clearly stands out", () => {
    // "more old-school" and "put it in a round badge", measured on 2026-11-04.
    expect(
      changeSetsFrom({
        style_retro: reading(0.65),
        type_emblem: reading(0.25),
        style_hand_drawn: reading(0.25),
      })
    ).toEqual({ style: "retro" })
    expect(
      changeSetsFrom({ type_emblem: reading(0.9), type_icon: reading(0.17) })
    ).toEqual({ type: "emblem" })
    // "a leaf instead of a tree": icon at 0.44 is not enough.
    expect(changeSetsFrom({ type_icon: reading(0.44) })).toEqual({})
    // Two close together are not a reading.
    expect(
      changeSetsFrom({
        style_minimal: reading(0.7),
        style_luxury: reading(0.6),
      })
    ).toEqual({})
  })
})
