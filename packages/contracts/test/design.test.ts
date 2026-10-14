import { describe, expect, it } from "vitest"
import {
  Blueprint,
  DesignDirection,
  FONT_PAIRS,
  FontPair,
  ImageSlot,
  INDUSTRY_PACK,
  LEGACY_FONT_PAIR,
  LEGACY_TEMPLATE_DIRECTION,
  PALETTE_AA_PAIRS,
  PALETTE_SWATCH,
  Palette,
  SECTION_VARIANTS,
  SectionKind,
  SectionVariant,
} from "../src/design.ts"
import {
  DirectionId,
  FONTS,
  FontId,
  INDUSTRIES,
  PALETTES,
  TEMPLATES,
  TemplateId,
} from "../src/index.ts"
import { samples } from "./samples.ts"

const sample = <T>(name: keyof typeof samples) =>
  structuredClone(samples[name]) as T
type Obj = Record<string, unknown>

/** WCAG 2.x relative luminance contrast of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe("FontPair", () => {
  it("parses every pair in fonts.json, each under its own id", () => {
    expect(FONT_PAIRS.length).toBeGreaterThanOrEqual(8)
    expect(new Set(FONT_PAIRS.map((p) => p.id)).size).toBe(FONT_PAIRS.length)
    for (const pair of FONT_PAIRS) {
      expect(FontPair.safeParse(pair).success, pair.id).toBe(true)
    }
  })

  it("keeps each pair to two families and four files at most", () => {
    for (const { id, display, body } of FONT_PAIRS) {
      const families = new Set([display.family, body.family])
      const files =
        display.weights.length * (display.italic ? 2 : 1) + body.weights.length
      expect(families.size, id).toBeLessThanOrEqual(2)
      expect(files, id).toBeLessThanOrEqual(4)
    }
  })

  it("refuses an unknown id, a weight CSS has no name for, no weights, a stray key", () => {
    const pair = sample<Obj>("FontPair")
    const display = pair.display as Obj
    const cases: Obj[] = [
      { ...pair, id: "comic_sans" },
      { ...pair, display: { ...display, weights: [450] } },
      { ...pair, display: { ...display, weights: [] } },
      { ...pair, display: { ...display, weights: [400, 500, 600, 700] } },
      { ...pair, body: { family: "figtree", weights: [400] } },
      { ...pair, body: { family: "Figtree", weights: [400], italic: true } },
      { ...pair, url: "https://fonts.example/figtree.woff2" },
    ]
    for (const candidate of cases) {
      expect(FontPair.safeParse(candidate).success).toBe(false)
    }
  })
})

describe("Palette", () => {
  const palette = sample<Record<string, string>>("Palette")

  it("parses six roles", () => {
    expect(Palette.parse(palette)).toEqual(palette)
  })

  it("names four swatch roles and five AA pairs, all of them roles", () => {
    expect(PALETTE_SWATCH).toHaveLength(4)
    for (const role of [
      ...PALETTE_SWATCH,
      ...PALETTE_AA_PAIRS.flatMap((p) => [p.text, p.on]),
    ]) {
      expect(Object.keys(palette)).toContain(role)
    }
  })

  it("reads at AA on every named pair, for the sample", () => {
    for (const { text, on } of PALETTE_AA_PAIRS) {
      const ratio = contrast(palette[text] as string, palette[on] as string)
      expect(ratio, `${text} on ${on}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("reads at AA on every named pair, for every shipped palette", () => {
    for (const {
      id,
      label,
      hint: _hint,
      brand: _b,
      swatches: _s,
      ...roles
    } of PALETTES) {
      const parsed = Palette.parse({ id, label, ...roles }) as Record<
        string,
        string
      >
      for (const { text, on } of PALETTE_AA_PAIRS) {
        const ratio = contrast(parsed[text] as string, parsed[on] as string)
        expect(ratio, `${id}: ${text} on ${on}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it("refuses a missing role, upper case, a short hex, a named colour, an unknown preset", () => {
    const { line: _line, ...missing } = palette
    const cases: Obj[] = [
      missing,
      { ...palette, ink: (palette.ink as string).toUpperCase() },
      { ...palette, ink: (palette.ink as string).slice(0, 4) },
      { ...palette, ink: "rebeccapurple" },
      { ...palette, id: "neon" },
      { ...palette, brand: palette.primary },
    ]
    for (const candidate of cases) {
      expect(Palette.safeParse(candidate).success).toBe(false)
    }
  })
})

describe("section kinds and variants", () => {
  it("gives every kind at least one variant, and lists each variant once per kind", () => {
    for (const [kind, variants] of Object.entries(SECTION_VARIANTS)) {
      expect(variants.length, kind).toBeGreaterThan(0)
      expect(new Set(variants).size, kind).toBe(variants.length)
      expect(SectionKind.safeParse(kind).success).toBe(true)
      for (const variant of variants) {
        expect(SectionVariant.safeParse(variant).success, variant).toBe(true)
      }
    }
  })

  it("refuses a kind or a variant nobody built", () => {
    expect(SectionKind.safeParse("carousel").success).toBe(false)
    expect(SectionVariant.safeParse("parallax").success).toBe(false)
  })
})

describe("DesignDirection", () => {
  const direction = sample<Obj>("DesignDirection")

  it("parses the sample", () => {
    expect(DesignDirection.parse(direction)).toEqual(direction)
  })

  it("accepts each radius and each band", () => {
    for (const radius of ["square", "soft", "round"]) {
      expect(DesignDirection.safeParse({ ...direction, radius }).success).toBe(
        true
      )
    }
    for (const bands of ["light", "one_dark", "two_dark", "inverted"]) {
      expect(DesignDirection.safeParse({ ...direction, bands }).success).toBe(
        true
      )
    }
  })

  it("refuses a variant of another kind, an unknown pair, no palettes, an unknown industry", () => {
    const cases: Obj[] = [
      { ...direction, hero: "photo_cards" },
      { ...direction, services: "wash" },
      { ...direction, fonts: "papyrus" },
      { ...direction, palettes: [] },
      { ...direction, palettes: ["neon"] },
      { ...direction, industries: [] },
      { ...direction, industries: ["astrology"] },
      { ...direction, radius: "pill" },
      { ...direction, bands: "three_dark" },
      { ...direction, id: "Calm Daylight" },
      { ...direction, extra: true },
    ]
    for (const candidate of cases) {
      expect(DesignDirection.safeParse(candidate).success).toBe(false)
    }
  })
})

describe("ImageSlot", () => {
  const upload = sample<Obj>("ImageSlot")
  const { asset_id: _asset, ...rest } = upload
  const generated = { ...rest, source: "generated" }

  it("takes an upload that names its asset", () => {
    expect(ImageSlot.safeParse(upload).success).toBe(true)
  })

  it("takes a generated slot with no asset yet, and with one", () => {
    expect(ImageSlot.safeParse(generated).success).toBe(true)
    expect(
      ImageSlot.safeParse({ ...generated, asset_id: upload.asset_id }).success
    ).toBe(true)
  })

  it("refuses an upload with no asset, and a source nobody offers", () => {
    expect(ImageSlot.safeParse({ ...rest, source: "upload" }).success).toBe(
      false
    )
    expect(ImageSlot.safeParse({ ...upload, source: "stock" }).success).toBe(
      false
    )
  })

  it("accepts each aspect, resolution and text side, and refuses others", () => {
    for (const aspect of ["16:9", "4:3", "3:4", "1:1", "21:9"]) {
      expect(ImageSlot.safeParse({ ...upload, aspect }).success, aspect).toBe(
        true
      )
    }
    for (const resolution of ["1K", "2K"]) {
      expect(ImageSlot.safeParse({ ...upload, resolution }).success).toBe(true)
    }
    for (const text_side of ["left", "right", "none"]) {
      expect(ImageSlot.safeParse({ ...upload, text_side }).success).toBe(true)
    }
    expect(ImageSlot.safeParse({ ...upload, aspect: "2:1" }).success).toBe(
      false
    )
    expect(ImageSlot.safeParse({ ...upload, resolution: "4K" }).success).toBe(
      false
    )
    expect(ImageSlot.safeParse({ ...upload, text_side: "top" }).success).toBe(
      false
    )
    expect(ImageSlot.safeParse({ ...upload, alt: "" }).success).toBe(false)
    expect(ImageSlot.safeParse({ ...upload, section: "footer" }).success).toBe(
      false
    )
  })
})

describe("Blueprint", () => {
  const blueprint = sample<Obj>("Blueprint")
  const features = blueprint.features as string[]
  const pages = blueprint.pages as { sections: Obj[] }[]

  it("parses the sample", () => {
    expect(Blueprint.parse(blueprint)).toEqual(blueprint)
  })

  it("takes the owner's own colour in place of a preset", () => {
    const brand = sample<Record<string, string>>("Palette").primary
    const own = { ...blueprint, palette: { kind: "brand", brand } }
    expect(Blueprint.safeParse(own).success).toBe(true)
    for (const palette of [
      { kind: "brand", id: "forest" },
      { kind: "preset", brand },
      { kind: "brand", brand: "forest" },
      { kind: "preset", id: "neon" },
    ]) {
      expect(Blueprint.safeParse({ ...blueprint, palette }).success).toBe(false)
    }
  })

  it("keeps the feature list to four to ten lines of at most 140 characters", () => {
    const ok = (list: string[]) =>
      Blueprint.safeParse({ ...blueprint, features: list }).success
    const line = (n: number) => "x".repeat(n)
    expect(ok(features.slice(0, 3))).toBe(false)
    expect(ok(features)).toBe(true)
    expect(ok(Array.from({ length: 10 }, () => line(140)))).toBe(true)
    expect(ok(Array.from({ length: 11 }, () => line(10)))).toBe(false)
    expect(ok([...features.slice(0, 3), line(141)])).toBe(false)
    expect(ok([...features.slice(0, 3), "   "])).toBe(false)
  })

  it("checks each section's variant against its own kind", () => {
    const withSection = (section: Obj) =>
      Blueprint.safeParse({
        ...blueprint,
        pages: [{ page: "home", sections: [section] }],
      }).success
    const base = {
      purpose: "Introduce the business",
      content_notes: null,
    }
    expect(withSection({ ...base, kind: "hero", variant: "dark_center" })).toBe(
      true
    )
    expect(withSection({ ...base, kind: "hero", variant: "photo_cards" })).toBe(
      false
    )
    expect(withSection({ ...base, kind: "faq", variant: "wash" })).toBe(false)
    expect(withSection({ ...base, kind: "gallery", variant: "default" })).toBe(
      true
    )
    expect(withSection({ ...base, kind: "carousel", variant: "default" })).toBe(
      false
    )
    expect(withSection({ ...base, kind: "hero" })).toBe(false)
  })

  it("refuses an unknown page, an empty page, no pages, and nine-plus-one", () => {
    const section = pages[0]?.sections[0] as Obj
    const page = (id: string) => ({ page: id, sections: [section] })
    const parses = (list: unknown[]) =>
      Blueprint.safeParse({ ...blueprint, pages: list }).success
    expect(parses([page("pricing")])).toBe(false)
    expect(parses([{ page: "home", sections: [] }])).toBe(false)
    expect(parses([])).toBe(false)
    expect(parses(Array.from({ length: 10 }, () => page("home")))).toBe(false)
  })

  it("allows at most two custom sections, named as components", () => {
    const custom = (list: unknown) =>
      Blueprint.safeParse({ ...blueprint, custom_sections: list }).success
    const one = { name: "SeasonalOffer", purpose: "A spring offer strip" }
    expect(custom(undefined)).toBe(true)
    expect(custom([one, { ...one, name: "AreaMap" }])).toBe(true)
    expect(custom([one, one, one])).toBe(false)
    expect(custom([{ ...one, name: "seasonal-offer" }])).toBe(false)
    expect(custom([{ ...one, name: "../Escape" }])).toBe(false)
  })

  it("refuses an unknown pair, a stray key and more slots than a site can hold", () => {
    const slot = (blueprint.images as Obj[])[0] as Obj
    expect(
      Blueprint.safeParse({ ...blueprint, fonts: "papyrus" }).success
    ).toBe(false)
    expect(Blueprint.safeParse({ ...blueprint, theme: "dark" }).success).toBe(
      false
    )
    expect(
      Blueprint.safeParse({
        ...blueprint,
        images: Array.from({ length: 25 }, () => slot),
      }).success
    ).toBe(false)
  })
})

/**
 * Stored facts hold `template` and `font` for every org that finished
 * onboarding. The values are pinned here as literals, so removing one from
 * the old enums fails this test instead of quietly shrinking the map.
 */
describe("ids from before directions and pairs", () => {
  const OLD_TEMPLATES = ["classic", "modern", "bold"]
  const OLD_FONTS = ["clean_sans", "classic_serif", "soft_rounded"]

  it("still accepts every old template and font id", () => {
    expect(TemplateId.options).toEqual(OLD_TEMPLATES)
    expect(TEMPLATES.map((t) => t.id)).toEqual(OLD_TEMPLATES)
    expect(FontId.options).toEqual(OLD_FONTS)
    expect(FONTS.map((f) => f.id)).toEqual(OLD_FONTS)
  })

  it("maps every old template to a direction id, and nothing else", () => {
    expect(Object.keys(LEGACY_TEMPLATE_DIRECTION).sort()).toEqual(
      [...OLD_TEMPLATES].sort()
    )
    for (const id of OLD_TEMPLATES) {
      const target =
        LEGACY_TEMPLATE_DIRECTION[id as keyof typeof LEGACY_TEMPLATE_DIRECTION]
      expect(DirectionId.safeParse(target).success, id).toBe(true)
    }
  })

  it("maps every old font to a pair that exists, and nothing else", () => {
    expect(Object.keys(LEGACY_FONT_PAIR).sort()).toEqual([...OLD_FONTS].sort())
    const pairs = FONT_PAIRS.map((p) => p.id as string)
    for (const id of OLD_FONTS) {
      const target = LEGACY_FONT_PAIR[id as keyof typeof LEGACY_FONT_PAIR]
      expect(pairs, id).toContain(target)
    }
  })

  it("gives every industry a pack, three of them their own", () => {
    expect(Object.keys(INDUSTRY_PACK).sort()).toEqual(
      INDUSTRIES.map((i) => i.id as string).sort()
    )
    expect(INDUSTRY_PACK.cleaning).toBe("cleaning")
    expect(INDUSTRY_PACK.legal).toBe("legal")
    // Limousine hire is `chauffeur` in stored facts; the id stays.
    expect(INDUSTRY_PACK.chauffeur).toBe("limousine")
    const own = new Set(["cleaning", "legal", "limousine"])
    for (const [industry, pack] of Object.entries(INDUSTRY_PACK)) {
      if (!own.has(pack)) {
        expect(pack, industry).toBe("service_business")
      }
    }
  })
})
