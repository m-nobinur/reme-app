import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { ROOT } from "./build"

// The craft floor every direction shares, measured from the reference site
// (spotless-templates.lovable.app) at 1440 and 390 px: the type scale, the
// container, the section rhythm, two weights per family, and no decoration the
// reference does not use. A direction may change the faces, the palette and
// the radius language; it may not change these.
const theme = readFileSync(join(ROOT, "src/styles/theme.css"), "utf8")
const css = readFileSync(join(ROOT, "src/styles/site.css"), "utf8")

const token = (name: string) => {
  const found = theme.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!found?.[1]) throw new Error(`theme.css has no --${name}`)
  return found[1].trim()
}

/** A length token in px at a viewport width: rem, vw, + and - terms, clamp(). */
const px = (value: string, width: number): number => {
  const term = (part: string) => {
    const n = Number.parseFloat(part)
    if (part.endsWith("rem")) return n * 16
    if (part.endsWith("vw")) return (n * width) / 100
    if (part.endsWith("px")) return n
    throw new Error(`cannot read ${part}`)
  }
  const sum = (expr: string) =>
    expr
      .replace(/\s+-\s+/g, " + -")
      .split(/\s+\+\s+/)
      .reduce((total, part) => total + term(part.trim()), 0)
  const clamp = value.match(/^clamp\((.+),(.+),(.+)\)$/)
  if (!clamp) return sum(value)
  const [low, mid, high] = clamp.slice(1).map((part) => sum(part.trim()))
  return Math.min(Math.max(mid ?? 0, low ?? 0), high ?? 0)
}

test("the length reader handles the forms the tokens use", () => {
  expect(px("1.5rem", 1440)).toBe(24)
  expect(px("10vw", 390)).toBe(39)
  expect(px("5.714vw - 0.143rem", 1000)).toBeCloseTo(54.852, 2)
  expect(px("clamp(3rem, 2.443rem + 2.286vw, 4.5rem)", 2000)).toBe(72)
  expect(px("clamp(3rem, 2.443rem + 2.286vw, 4.5rem)", 320)).toBe(48)
})

describe("the type scale and rhythm match the reference at both widths", () => {
  // [token, px at 390, px at 1440], each within a pixel.
  const MEASURED: [string, number, number][] = [
    ["text-hero", 48, 72],
    ["text-2xl", 32, 42],
    ["text-xl", 23, 23],
    ["text-base", 16, 16],
    ["text-sm", 14, 14],
    ["text-xs", 11, 11],
    ["section-pad", 56, 82],
    ["gutter", 20, 80],
    ["container", 1280, 1280],
  ]
  test.each(MEASURED)(
    "--%s is %i px at 390 and %i px at 1440",
    (name, phone, wide) => {
      expect(Math.abs(px(token(name), 390) - phone)).toBeLessThanOrEqual(1)
      expect(Math.abs(px(token(name), 1440) - wide)).toBeLessThanOrEqual(1)
    }
  )

  test("display type is set at one weight and normal tracking", () => {
    expect(token("display-weight")).toBe("500")
    expect(px(token("display-tracking").replace("em", "rem"), 0)).toBe(0)
  })

  test("cards, photos and buttons keep small radii", () => {
    for (const name of ["radius-card", "radius-media", "radius-button"])
      expect(px(token(name), 1440), name).toBeLessThanOrEqual(8)
  })
})

describe("the finish stays as restrained as the reference's", () => {
  test("body text asks only for the weights a pair ships, 400 and 500", () => {
    const weights = [...css.matchAll(/font-weight:\s*([^;]+);/g)].map((match) =>
      match[1]?.trim()
    )
    expect(weights.length).toBeGreaterThan(10)
    expect(
      weights.filter(
        (weight) =>
          !["400", "500", "var(--display-weight)"].includes(weight ?? "")
      )
    ).toEqual([])
  })

  test("nothing draws a shadow", () => {
    expect(css).not.toMatch(/box-shadow:(?!\s*none)/)
    expect(theme).not.toMatch(/--shadow/)
  })

  test("the one gradient is the scrim that keeps copy readable on a photo", () => {
    const gradients = [...css.matchAll(/([^{}]+)\{[^{}]*gradient\(/g)].map(
      (match) => match[1]?.trim()
    )
    expect(gradients).toEqual([
      ".hero-dark_center.hero-photo .hero-media::after",
    ])
  })

  test("a band's tint is never beside another tinted band", () => {
    expect(css).toContain("nth-child(3n + 2 of .band)")
    expect(css).toContain(".band-tint + .band")
    expect(css).toContain(":has(+ .band-tint)")
  })
})
