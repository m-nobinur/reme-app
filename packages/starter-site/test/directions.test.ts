import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DesignDirection,
  LEGACY_TEMPLATE_DIRECTION,
  PALETTES,
  SECTION_VARIANTS,
  TEMPLATES,
} from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { brandRamp, contrast } from "../src/brand"
import { DIRECTIONS, directionOf, LEGACY } from "../src/directions"
import { PAIRS } from "../src/fonts"
import { type Built, build, clean, type Page, ROOT, readPages } from "./build"
import { FILLED } from "./fixture"

const AA = 4.5
/** The page the derived text sits on. */
const { surface: SURFACE, chosen } = JSON.parse(
  readFileSync(join(ROOT, "test/brand-colours.json"), "utf8")
) as { surface: string; chosen: Record<string, string> }
/** A brand colour the palette has to win over. */
const RED = chosen["saturated red"] as string
const ONYX = PALETTES.find((each) => each.id === "onyx")
if (!ONYX) throw new Error("no onyx palette")
/** A preset as site.palette carries it. */
const ROLES = (["paper", "ink", "primary", "tint", "accent", "line"] as const)
  .map((role) => `${role}:${ONYX[role]}`)
  .join(" ")

describe("the directions library", () => {
  test("holds at least eight directions, each a complete row of the contract", () => {
    expect(DIRECTIONS.length).toBeGreaterThanOrEqual(8)
    for (const each of DIRECTIONS) {
      expect(DesignDirection.safeParse(each).error, each.id).toBeUndefined()
      expect(PAIRS, each.id).toHaveProperty(each.fonts)
    }
    const ids = DIRECTIONS.map((each) => each.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("gives each direction a type pair of its own and a distinct composition", () => {
    const pairs = DIRECTIONS.map((each) => each.fonts)
    expect(new Set(pairs).size).toBe(pairs.length)
    const shapes = DIRECTIONS.map(
      (each) => `${each.hero} ${each.services} ${each.radius} ${each.bands}`
    )
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  test("uses every hero and services variant somewhere", () => {
    expect(new Set(DIRECTIONS.map((each) => each.hero))).toEqual(
      new Set(SECTION_VARIANTS.hero)
    )
    expect(new Set(DIRECTIONS.map((each) => each.services))).toEqual(
      new Set(SECTION_VARIANTS.service_cards)
    )
  })

  test("reads an old template as the contract's direction, and the first for anything else", () => {
    expect(LEGACY).toEqual(LEGACY_TEMPLATE_DIRECTION)
    for (const { id } of TEMPLATES)
      expect(directionOf(id).id, id).toBe(LEGACY_TEMPLATE_DIRECTION[id])
    // An unconfigured site keeps the old default template's look.
    expect(DIRECTIONS[0]?.id).toBe(LEGACY.classic)
    for (const value of ["", "nonsense", "constructor", " counsel "])
      expect(directionOf(value).id, value).toBe(
        value === " counsel " ? "counsel" : DIRECTIONS[0]?.id
      )
  })

  for (const palette of PALETTES) {
    test(`${palette.id} reads at AA on the brand and on the page`, () => {
      const ramp = brandRamp(palette.brand)
      if (!ramp) throw new Error(`${palette.brand} was refused`)
      expect(contrast(ramp.foreground, ramp.brand)).toBeGreaterThanOrEqual(AA)
      expect(contrast(ramp.text, SURFACE)).toBeGreaterThanOrEqual(AA)
    })
  }
})

const built: Partial<Record<string, Built>> = {}
const ONE_PHOTO = { photo2Src: "", photo2Alt: "", photo3Src: "", photo3Alt: "" }

beforeAll(async () => {
  const [fresh_modern, calm_daylight, after_dark, panel] = await Promise.all([
    build({ site: FILLED }),
    // An old template id, as a site stored before directions.
    build({ site: { ...FILLED, direction: "modern", font: "classic_serif" } }),
    // After dark carries one gallery photo and the panel build no hero photo,
    // so the single figure and the photo-free hero are each built once.
    build({
      site: {
        ...FILLED,
        direction: "after_dark",
        palette: ROLES,
        brandColor: RED,
        ...ONE_PHOTO,
      },
    }),
    build({ site: { ...FILLED, heroImage: "", logo: "" } }),
  ])
  Object.assign(built, { fresh_modern, calm_daylight, after_dark, panel })
}, 120_000)

afterAll(() => {
  for (const each of Object.values(built)) clean(each)
})

const home = (name: string): Page => {
  const dist = built[name]?.dist
  if (!dist) throw new Error(`the ${name} build did not run`)
  const page = readPages(dist).find((each) => each.file === "index.html")
  if (!page) throw new Error(`the ${name} build has no home page`)
  return page
}
const classes = (page: Page) =>
  page.elements.flatMap((el) => (el.attrs.class ?? "").split(" "))
/** Where each section first appears in the page source. */
const at = (page: Page, name: string) => page.html.indexOf(`class="${name}`)

const NAMES = ["fresh_modern", "calm_daylight", "after_dark"] as const

describe("a direction", () => {
  test("names itself, its radius and its bands on the page for the styles to key off", () => {
    for (const name of NAMES) {
      const direction = directionOf(name)
      const root = home(name).elements.find((el) => el.tag === "html")
      expect(root?.attrs["data-direction"], name).toBe(name)
      expect(root?.attrs["data-radius"], name).toBe(direction.radius)
      expect(root?.attrs["data-bands"], name).toBe(direction.bands)
      expect(root?.attrs["data-template"], name).toBeUndefined()
    }
  })

  test("gives every section with no variant of its own the direction's", () => {
    for (const name of NAMES) {
      const { hero, services, steps, faq } = directionOf(name)
      const found = classes(home(name))
      expect(found, name).toContain("hero-home")
      for (const each of [
        `hero-${hero}`,
        `services-${services}`,
        `steps-${steps}`,
        `faq-${faq}`,
      ])
        expect(found, `${name} ${each}`).toContain(each)
    }
  })

  test("styles radius and bands by axis and leaves no template rule behind", () => {
    const css = ["theme.css", "site.css"]
      .map((file) => readFileSync(join(ROOT, "src/styles", file), "utf8"))
      .join("\n")
    expect(css).not.toContain("data-template")
    for (const radius of ["square", "round"])
      expect(css).toContain(`[data-radius="${radius}"]`)
    for (const bands of ["light", "two_dark", "inverted"])
      expect(css).toContain(`[data-bands="${bands}"]`)
  })

  test("carries the palette's six roles to the page exactly, over the brand colour", () => {
    const { html } = home("after_dark")
    for (const each of [
      `--brand:${ONYX.primary}`,
      `--brand-foreground:${ONYX.paper}`,
      `--role-tint:${ONYX.tint}`,
      `--role-line:${ONYX.line}`,
      `--role-accent:${ONYX.accent}`,
    ])
      expect(html).toContain(each)
    expect(html).not.toContain(RED)
  })

  test("leads with the proof, then the services, and closes on the questions", () => {
    for (const name of NAMES) {
      const page = home(name)
      expect(at(page, "trust-strip"), name).toBeLessThan(
        at(page, "band service-cards")
      )
      expect(at(page, "band service-cards"), name).toBeLessThan(
        at(page, "band faq")
      )
    }
  })

  test("puts the owner's photo in the hero, or the services when there is none", () => {
    for (const name of NAMES) {
      const img = home(name).elements.find((el) =>
        (el.attrs.class ?? "").split(" ").includes("hero-image")
      )
      expect(img?.attrs.src, name).toBe(FILLED.heroImage)
      expect(img?.attrs.alt, name).toBe(FILLED.heroImageAlt)
      expect(classes(home(name)), name).toContain("hero-photo")
      expect(classes(home(name)), name).not.toContain("hero-list")
    }
    expect(classes(home("panel"))).toContain("hero-plain")
    expect(classes(home("panel"))).toContain("hero-list")
    expect(classes(home("panel"))).not.toContain("hero-image")
    expect(home("panel").texts).toContain(FILLED.service1Name)
  })

  test("shows the owner's logo in place of the name, and the name as text without one", () => {
    const logos = (page: Page) =>
      page.elements.filter((el) =>
        (el.attrs.class ?? "").split(" ").includes("site-logo")
      )
    for (const name of NAMES) {
      const found = logos(home(name))
      expect(found, name).toHaveLength(2)
      for (const img of found) {
        expect(img.attrs.src, name).toBe(FILLED.logo)
        expect(img.attrs.alt, name).toBe(FILLED.logoAlt)
      }
    }
    expect(logos(home("panel"))).toEqual([])
    expect(home("panel").texts).toContain(FILLED.businessName)
  })

  test("shows one photo as a single figure and more as a grid of tiles", () => {
    expect(classes(home("after_dark"))).toContain("gallery-single")
    expect(classes(home("after_dark"))).not.toContain("gallery-grid")
    expect(classes(home("fresh_modern"))).toContain("gallery-grid")
    expect(classes(home("fresh_modern"))).not.toContain("gallery-single")
  })

  test("crops every photo to a fixed shape", () => {
    const css = readFileSync(join(ROOT, "src/styles/site.css"), "utf8")
    for (const selector of [
      ".hero-image",
      ".gallery-grid img",
      ".gallery-single img",
      ".story-photo",
    ]) {
      const rule =
        css.match(
          new RegExp(`\\n${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`)
        )?.[1] ?? ""
      expect(rule, selector).toContain("object-fit: cover")
      expect(rule, selector).toMatch(/aspect-ratio: \d+ \/ \d+/)
    }
    expect(css).not.toMatch(/gallery-grid \{[^}]*auto-fit/)
    // A logo keeps its own shape, at a fixed height.
    expect(css).toMatch(
      /\n\.site-logo \{[^}]*height: 2\.5rem;[^}]*object-fit: contain;/
    )
  })

  test("sets the about page's story beside the owner's photo", () => {
    for (const name of NAMES) {
      const about = readPages(built[name]?.dist ?? "").find(
        (each) => each.file === "about/index.html"
      )
      expect(about && classes(about), name).toContain("story-split")
    }
    expect(readFileSync(join(ROOT, "src/styles/site.css"), "utf8")).toMatch(
      /@media \(min-width: 56rem\) \{\s*\.story-split \{\s*grid-template-columns/
    )
  })

  test("shows the industry above the heading", () => {
    expect(home("fresh_modern").texts).toContain(FILLED.industry)
  })

  test("carries the chosen type and colour in the head", () => {
    // The legacy classic_serif is the Newsreader and Inter pair.
    expect(home("calm_daylight").html).toContain("--display-weight:500")
    expect(home("fresh_modern").html).not.toContain("--display-weight:")
  })
})
