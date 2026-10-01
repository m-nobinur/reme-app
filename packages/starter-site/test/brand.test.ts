import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { brandRamp, brandTheme, contrast } from "../src/brand"
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

  test("a colour that is not a hex colour leaves the default theme", () => {
    for (const value of colours.refused) {
      expect(brandRamp(value), value).toBeUndefined()
      expect(brandTheme(value), value).toBe("")
    }
  })

  test("the theme is one rule naming the three properties", () => {
    const first = Object.values(colours.chosen)[0] as string
    const css = brandTheme(first)
    expect(css.startsWith("html:root{")).toBe(true)
    for (const property of ["--brand:", "--brand-foreground:", "--brand-text:"])
      expect(css).toContain(property)
  })
})
