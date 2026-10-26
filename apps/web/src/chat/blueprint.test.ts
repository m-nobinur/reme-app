import { type Blueprint, PALETTES } from "@workspace/contracts"
import {
  changedRows,
  generatedLine,
  paletteStops,
} from "@workspace/ui/lib/blueprint"
import { describe, expect, it } from "vitest"

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
      "2 photos will be made for you: Home hero (2). 1 is yours."
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
