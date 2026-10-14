import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { FONT_PAIRS, LEGACY_FONT_PAIR } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { filesOf, LEGACY, PAIRS, pairOf } from "../src/fonts"
import { type Built, build, clean, ROOT, readPages } from "./build"
import { FILLED } from "./fixture"

/** At most 120 KB of font transfer on the home page (VS1's budget). */
const FONT_BUDGET = 120 * 1024

const sizeOf = (file: string) => statSync(join(ROOT, "node_modules", file)).size
const woff2 = (dist: string) =>
  readdirSync(dist, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".woff2"))

describe("the pairs", () => {
  test("are the contract's pairs, weights and italics included", () => {
    expect(Object.keys(PAIRS).sort()).toEqual(
      FONT_PAIRS.map((p) => p.id).sort()
    )
    for (const { id, display, body } of FONT_PAIRS) {
      expect(PAIRS[id], id).toEqual({ display, body })
    }
    expect(LEGACY).toEqual(LEGACY_FONT_PAIR)
  })

  test("read a legacy id as the pair it means, and anything else as none", () => {
    expect(pairOf("clean_sans")).toBe(PAIRS.outfit_figtree)
    expect(pairOf(" sora_manrope ")).toBe(PAIRS.sora_manrope)
    for (const value of ["", "constructor", "Comic Sans"]) {
      expect(pairOf(value), value).toBeUndefined()
    }
  })

  for (const [id, pair] of Object.entries(PAIRS)) {
    test(`${id} is two families, at most four files, under the transfer line`, () => {
      const files = filesOf(pair)
      expect(new Set([pair.display.family, pair.body.family]).size).toBe(2)
      // The italic display loads only where the page sets italic text, so the
      // line counts it too: it is the worst case, not the common one.
      expect(files.length).toBeLessThanOrEqual(4)
      for (const file of files) {
        expect(existsSync(join(ROOT, "node_modules", file)), file).toBe(true)
      }
      const bytes = files.reduce((sum, file) => sum + sizeOf(file), 0)
      expect(bytes, `${bytes} B`).toBeLessThanOrEqual(FONT_BUDGET)
    })
  }
})

describe("a built site", () => {
  const built: Partial<Record<string, Built>> = {}

  beforeAll(async () => {
    const [none, sora, fraunces] = await Promise.all([
      build({ site: FILLED }),
      build({ site: { ...FILLED, font: "sora_manrope" } }),
      build({ site: { ...FILLED, font: "dmsans_fraunces" } }),
    ])
    Object.assign(built, { none, sora, fraunces })
  }, 180_000)

  afterAll(() => {
    for (const each of Object.values(built)) clean(each)
  })

  const home = (name: string) => {
    const dist = built[name]?.dist ?? ""
    const page = readPages(dist).find((each) => each.file === "index.html")
    if (!page) throw new Error(`${name} has no home page`)
    return { dist, html: page.html, links: page.elements }
  }

  test("with no pair ships no font file and no font rule", () => {
    const { dist, html } = home("none")
    expect(woff2(dist)).toEqual([])
    expect(html).not.toContain("--face-")
  })

  test("preloads the display face and not the body face", () => {
    const { html, links } = home("sora")
    const preloads = links.filter(
      (each) => each.tag === "link" && each.attrs.as === "font"
    )
    expect(preloads).toHaveLength(1)
    expect(preloads[0]?.attrs.type).toBe("font/woff2")
    expect(preloads[0]?.attrs.crossorigin).toBeDefined()
    expect(html).toContain("--face-display:")
    expect(html).toContain("--face-body:")
    expect(html).toContain("--display-weight:500")
  })

  test("ships only that pair's files, each a woff2 from the page's own origin", () => {
    const { dist, html } = home("sora")
    const files = woff2(dist)
    expect(files.length).toBeLessThanOrEqual(4)
    expect(html).not.toMatch(/https?:\/\/[^"' ]*\.(woff2?|ttf|otf)/)
    expect(html).not.toContain("fonts.googleapis")
  })

  test("sets a pair's italic accent as a face of its own", () => {
    const { dist, html } = home("fraunces")
    // Fraunces 500 upright and italic, DM Sans 400 and 500.
    expect(woff2(dist)).toHaveLength(4)
    expect(html).toContain("--accent-style:italic")
    expect(home("sora").html).not.toContain("--accent-style")
  })

  test("gives each face a fallback that holds the layout", () => {
    const { html } = home("sora")
    // Astro hashes the family name, so match the fallback's shape, not its name.
    expect(html).toMatch(/Sora-\w+ fallback: Arial/)
    expect(html).toMatch(/Manrope-\w+ fallback: Arial/)
    expect(html).toMatch(/size-adjust:[\d.]+%;ascent-override:/)
  })
})
