import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PALETTE_AA_PAIRS, PALETTES } from "@workspace/contracts"
import { describe, expect, test } from "vitest"
import {
  brandRamp,
  brandTheme,
  contrast,
  mutedOf,
  paletteFromBrand,
  paletteOf,
} from "../src/brand"
import { ROOT } from "./build"

const AA = 4.5
const colours = JSON.parse(
  readFileSync(join(ROOT, "test/brand-colours.json"), "utf8")
) as {
  surface: string
  chosen: Record<string, string>
  refused: string[]
}

describe("a theme derived from the owner's colour", () => {
  for (const [name, value] of Object.entries(colours.chosen)) {
    test(`${name} reads at AA on the brand and on the page`, () => {
      const ramp = brandRamp(value)
      if (!ramp) throw new Error(`${value} was refused`)
      expect(
        contrast(ramp.foreground, ramp.brand),
        `${ramp.foreground} on ${ramp.brand}`
      ).toBeGreaterThanOrEqual(AA)
      expect(
        contrast(ramp.text, colours.surface),
        `${ramp.text} on ${colours.surface}`
      ).toBeGreaterThanOrEqual(AA)
    })
  }

  for (const [name, value] of Object.entries(colours.chosen)) {
    test(`${name} gives a palette whose named pairs read at AA`, () => {
      const palette = paletteFromBrand(value) as Record<string, string>
      expect(palette, value).toBeDefined()
      for (const { text, on } of PALETTE_AA_PAIRS)
        expect(
          contrast(palette[text] as string, palette[on] as string),
          `${text} on ${on}`
        ).toBeGreaterThanOrEqual(AA)
    })
  }

  test("a colour that is not a hex colour leaves the default theme", () => {
    for (const value of colours.refused) {
      expect(brandRamp(value), value).toBeUndefined()
      expect(brandTheme(value), value).toBe("")
      expect(paletteFromBrand(value), value).toBeUndefined()
    }
  })

  test("the theme is one rule naming the three properties", () => {
    const first = Object.values(colours.chosen)[0] as string
    const css = brandTheme(first)
    expect(css.startsWith("html:root{")).toBe(true)
    for (const property of [
      "--brand:",
      "--brand-foreground:",
      "--brand-text:",
      "--background:",
      "--role-tint:",
    ])
      expect(css).toContain(property)
  })
})

describe("a theme from a preset's six roles", () => {
  const ROLES = ["paper", "ink", "primary", "tint", "accent", "line"] as const
  const roles = (each: (typeof PALETTES)[number]) =>
    ROLES.map((role) => `${role}:${each[role]}`).join(" ")

  test("every preset reaches the page exactly, over any brand colour", () => {
    const red = colours.chosen["saturated red"] as string
    for (const each of PALETTES) {
      const css = brandTheme(red, roles(each))
      const text = /--brand-text:(#[0-9a-f]{6})/.exec(css)?.[1] ?? ""
      // The text shade is the primary itself: every preset holds it on the tint.
      expect(text, each.id).toBe(each.primary)
      // A dark paper swaps the names the stylesheet reads as surface and text.
      const swap =
        each.id === "after_dark"
          ? `;--ink:${each.paper};--paper:${each.ink};color-scheme:dark`
          : ""
      expect(css, each.id).toBe(
        `html:root{--brand:${each.primary};--brand-foreground:${each.paper};--brand-text:${text};--background:${each.paper};--foreground:${each.ink};--muted-foreground:${mutedOf(each)};--role-tint:${each.tint};--role-line:${each.line};--role-accent:${each.accent}${swap}}`
      )
      // Secondary text eases off the ink and still reads on paper and tint.
      const muted = mutedOf(each)
      expect(muted, each.id).not.toBe(each.ink)
      for (const ground of [each.paper, each.tint])
        expect(contrast(muted, ground), each.id).toBeGreaterThanOrEqual(AA)
      // The label colour is the palette's paper, an AA pair on its primary.
      expect(
        contrast(each.paper, each.primary),
        each.id
      ).toBeGreaterThanOrEqual(AA)
    }
  })

  test("short of six hex roles, the brand colour decides", () => {
    const forest = PALETTES.find((each) => each.id === "forest")
    if (!forest) throw new Error("no forest palette")
    const blue = colours.chosen["mid blue"] as string
    const five = roles(forest).split(" ").slice(0, 5).join(" ")
    expect(paletteOf(five)).toBeUndefined()
    expect(paletteOf(roles(forest).replace(forest.ink, "dark"))).toBeUndefined()
    expect(brandTheme(blue, five)).toBe(brandTheme(blue))
    expect(brandTheme("", five)).toBe("")
  })
})
