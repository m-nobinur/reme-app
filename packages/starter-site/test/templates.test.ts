import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PALETTES, TEMPLATES } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { brandRamp, contrast } from "../src/brand"
import { HERO_OF, TEMPLATES as LAYOUTS } from "../src/presets"
import { type Built, build, clean, type Page, ROOT, readPages } from "./build"
import { FILLED } from "./fixture"

const AA = 4.5
/** The page the derived text sits on. */
const { surface: SURFACE } = JSON.parse(
  readFileSync(join(ROOT, "test/brand-colours.json"), "utf8")
) as { surface: string }
/** The palette the bold build wears. */
const MIDNIGHT = PALETTES.find((each) => each.id === "midnight")?.brand ?? ""

describe("the presets", () => {
  test("offer the contract's templates, the first the default", () => {
    expect([...LAYOUTS]).toEqual(TEMPLATES.map((each) => each.id))
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
  const [classic, modern, bold, panel] = await Promise.all([
    build({ site: FILLED }),
    build({ site: { ...FILLED, template: "modern", font: "classic_serif" } }),
    // Bold carries one gallery photo and the panel build no hero photo, so
    // the single figure and the photo-free hero are each built once.
    build({
      site: { ...FILLED, template: "bold", brandColor: MIDNIGHT, ...ONE_PHOTO },
    }),
    build({ site: { ...FILLED, heroImage: "", logo: "" } }),
  ])
  Object.assign(built, { classic, modern, bold, panel })
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

describe("a template", () => {
  test("names itself on the page for the styles to key off", () => {
    for (const name of ["classic", "modern", "bold"]) {
      const root = home(name).elements.find((el) => el.tag === "html")
      expect(root?.attrs["data-template"], name).toBe(name)
    }
  })

  test("gives each template a hero variant of its own, styled", () => {
    const css = readFileSync(join(ROOT, "src/styles/site.css"), "utf8")
    expect(new Set(Object.values(HERO_OF)).size).toBe(LAYOUTS.length)
    for (const name of LAYOUTS) {
      expect(classes(home(name)), name).toContain("hero-home")
      expect(classes(home(name)), name).toContain(`hero-${HERO_OF[name]}`)
      expect(css, name).toContain(`.hero-${HERO_OF[name]} `)
      expect(css, name).toContain(`[data-template="${name}"]`)
    }
  })

  test("leads with the proof, then the services, and closes on the questions", () => {
    for (const name of ["classic", "modern", "bold"]) {
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
    for (const name of ["classic", "modern", "bold"]) {
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
    for (const name of ["classic", "modern", "bold"]) {
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
    expect(classes(home("bold"))).toContain("gallery-single")
    expect(classes(home("bold"))).not.toContain("gallery-grid")
    expect(classes(home("classic"))).toContain("gallery-grid")
    expect(classes(home("classic"))).not.toContain("gallery-single")
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
    for (const name of ["classic", "modern", "bold"]) {
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
    expect(home("classic").texts).toContain(FILLED.industry)
  })

  test("carries the chosen type and colour in the head", () => {
    // The modern build's legacy classic_serif is the Newsreader and Inter pair.
    expect(home("modern").html).toContain("--display-weight:500")
    expect(home("bold").html).toContain(`--brand:${brandRamp(MIDNIGHT)?.brand}`)
    expect(home("classic").html).not.toContain("--display-weight:")
  })
})
