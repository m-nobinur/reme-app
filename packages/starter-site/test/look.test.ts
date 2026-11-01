import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PALETTES } from "@workspace/contracts"
import { beforeAll, describe, expect, test } from "vitest"
import { accentParts, plain } from "../src/accent"
import { paletteFromBrand } from "../src/brand"
import { layout } from "../src/page-fields"
import { seedDocuments } from "../src/page-seed"
import { type Built, build, ROOT, readPages } from "./build"
import { FILLED } from "./fixture"

// Design rules 2 and 3 of vs-visual-system.md as the starter enforces them: a
// section with an h2 has an eyebrow, and its heading can set a clause in the
// accent. Every section heading field carries a marked clause here, so a
// heading that drops the marker is one the starter cannot accent.
const HEADINGS = [
  "serviceCardsHeading",
  "stepsHeading",
  "testimonialsHeading",
  "faqHeading",
  "galleryHeading",
  "valuePropsHeading",
  "aboutHeading",
  "overviewHeading",
  "proofHeading",
  "offeringsHeading",
  "serviceAreaHeading",
  "ctaHeading",
  "quoteAsideHeading",
  "quoteTalkHeading",
  "homeAboutHeading",
  "aboutCtaHeading",
  "service1StepsHeading",
  "service1FaqHeading",
  "service1CtaHeading",
  "approachHeading",
  "aboutStepsHeading",
  "aboutAreaHeading",
  "contactIncludeHeading",
  "servicesHelpHeading",
  "servicesFaqHeading",
  // An h3 under the about story, not a section h2.
  "audienceHeading",
] as const
const MARKED = {
  ...FILLED,
  ...Object.fromEntries(HEADINGS.map((key) => [key, `Plain words, *${key}*`])),
  // A marked clause followed by a question mark keeps the mark.
  ctaHeading: "Ready for *ctaHeading*?",
  // Item titles that carry the marks show none.
  step1Title: "Visit *step1Title*",
  valueProp1Title: "Care *valueProp1Title*",
}

let built: Built | undefined
beforeAll(async () => {
  built = await build({ site: MARKED })
}, 120_000)

const sectionsOf = (html: string) =>
  [...html.matchAll(/<section[\s>][\s\S]*?<\/section>/g)].map(
    (match) => match[0]
  )

/** A list of items, such as the services page's cards, whose names are h2 when no section head sits above them. */
const withoutItems = (section: string) =>
  section.replace(/<(ul|ol)\b[\s\S]*?<\/\1>/g, "")

describe("eyebrows and accent clauses (rules 2 and 3)", () => {
  test("every section with an h2 opens with an eyebrow", () => {
    if (!built) throw new Error("the build did not run")
    const pages = readPages(built.dist)
    // Guards the check itself: the fixture home page holds many sections.
    expect(
      sectionsOf(pages.find((page) => page.file === "index.html")?.html ?? "")
        .length
    ).toBeGreaterThan(3)
    const bare = pages.flatMap((page) =>
      sectionsOf(page.html)
        .filter((section) => withoutItems(section).includes("<h2"))
        .filter((section) => !section.includes('class="eyebrow"'))
        .map((section) => `${page.file}: ${section.slice(0, 80)}`)
    )
    expect(bare).toEqual([])
  })

  // Limousine build: the home page's CTA band document held an empty eyebrow.
  test("a section whose document leaves its eyebrow empty shows the slot's own", async () => {
    const blank = await build({
      site: {
        ...FILLED,
        ctaEyebrow: "",
        faqEyebrow: "",
        stepsEyebrow: "",
        areaEyebrow: "",
        valuePropsEyebrow: "",
      },
      layout,
    })
    const home =
      readPages(blank.dist).find((each) => each.file === "index.html")?.html ??
      ""
    const sections = sectionsOf(home)
    expect(sections.find((each) => each.includes("cta-band"))).toContain(
      '<p class="eyebrow">Next step</p>'
    )
    const bare = sections
      .filter((each) => withoutItems(each).includes("<h2"))
      .filter((each) => !each.includes('class="eyebrow"'))
    expect(bare).toEqual([])
  }, 120_000)

  // Legal build: a contact note led by an h3 under the h1, its section's own h2 never shown.
  test("a contact note with no heading of its own sits under the section's", async () => {
    const doc = seedDocuments(FILLED, layout, true)["contact.json"] as {
      sections: {
        kind: string
        eyebrow?: string
        heading?: string
        blocks?: {
          id: string
          type: string
          provenance: string
          markdown?: string
        }[]
      }[]
    }
    const contact = doc.sections.find((each) => each.kind === "contact")
    if (!contact) throw new Error("the seed has no contact section")
    contact.eyebrow = "Contact details"
    contact.heading = "Call or email the practice"
    contact.blocks = [
      {
        id: "contact-note",
        type: "prose",
        provenance: "facts",
        markdown: "### What to put in your message\n\nSay when.",
      },
    ]
    const planted = await build({
      site: FILLED,
      layout,
      files: {
        "src/content/pages/contact.json": new TextEncoder().encode(
          JSON.stringify(doc)
        ),
      },
    })
    const html =
      readPages(planted.dist).find((each) => each.file === "contact/index.html")
        ?.html ?? ""
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) =>
      Number(m[1])
    )
    expect(levels.slice(0, 3)).toEqual([1, 2, 3])
    expect(html).toContain("Call or email the practice")
  }, 120_000)

  test("every section heading field can set a clause in the accent", () => {
    if (!built) throw new Error("the build did not run")
    const pages = readPages(built.dist)
    const plainH2 = pages.flatMap((page) =>
      sectionsOf(page.html).flatMap((section) =>
        // A service's own name on the services page is an item, not a heading field.
        [
          ...withoutItems(section)
            .replace(/<article[\s\S]*?<\/article>/g, "")
            .matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g),
        ]
          .filter(([, inner]) => !inner?.includes('class="accent"'))
          .map(([, inner]) => `${page.file}: ${inner}`)
      )
    )
    expect(plainH2).toEqual([])
  })

  // Perf run 3: an About h3 read "Work for *homeowners and landlords*".
  test("no heading, of any level, shows a literal asterisk", () => {
    if (!built) throw new Error("the build did not run")
    const marks = readPages(built.dist).flatMap((page) =>
      [...page.html.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/g)]
        .filter(([, , inner]) => inner?.includes("*"))
        .map(([, tag, inner]) => `${page.file} ${tag}: ${inner}`)
    )
    expect(marks).toEqual([])
    const about = readPages(built.dist).find(
      (page) => page.file === "about/index.html"
    )
    expect(about?.html).toMatch(
      /<h3[^>]*>Plain words, <span class="accent">audienceHeading<\/span><\/h3>/
    )
  })

  // Perf run 3: a CTA heading lost its question mark.
  test("the punctuation after a marked clause is kept", () => {
    expect(accentParts("Ready to clear *your list*?").tail).toBe("?")
    if (!built) throw new Error("the build did not run")
    const html = readPages(built.dist)
      .map((page) => page.html)
      .join("")
    expect(html).toContain('<span class="accent">ctaHeading</span>?</h2>')
  })

  test("an h1 and a title never show the marks", () => {
    if (!built) throw new Error("the build did not run")
    const marks = readPages(built.dist).flatMap((page) =>
      [...page.html.matchAll(/<(h1|title)[^>]*>([^<]*)</g)]
        .filter(([, , text]) => text?.includes("*"))
        .map(([, tag, text]) => `${page.file} ${tag}: ${text}`)
    )
    expect(marks).toEqual([])
  })

  test("an unmarked heading has no accent and an unpaired asterisk is text", () => {
    expect(accentParts("Why choose us")).toEqual({
      lead: "Why choose us",
      accent: "",
      tail: "",
    })
    expect(accentParts("Why *choose us* today")).toEqual({
      lead: "Why ",
      accent: "choose us",
      tail: " today",
    })
    expect(accentParts("Rated 5* by us").accent).toBe("")
    expect(plain("Why *choose us*")).toBe("Why choose us")
  })
})

// Design rule 5: neutrals lean toward the hue. Measured in OKLCH, where a flat
// slate is a tint with almost no chroma, or one whose hue belongs to neither
// the primary nor the accent.
const lin = (c: number) =>
  c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4
function oklch(hex: string): { L: number; C: number; H: number } {
  const [r, g, b] = [1, 3, 5].map((i) =>
    lin(Number.parseInt(hex.slice(i, i + 2), 16))
  ) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    C: Math.hypot(a, bb),
    H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  }
}

describe("neutrals lean toward the hue (rule 5)", () => {
  // A preset's neutrals are the owner's picks from reference palettes, white
  // papers and Charcoal's greys among them, so the rule binds derived ones.

  test("a colour the owner picks gets a tint and a line with chroma too", () => {
    // Every saturated accent the palettes ship, as a colour an owner might pick.
    const picked = PALETTES.map((each) => each.accent).filter(
      (hex) => oklch(hex).C > 0.1
    )
    expect(picked.length).toBeGreaterThan(10)
    for (const brand of picked) {
      const palette = paletteFromBrand(brand)
      expect(oklch(palette?.tint ?? brand).C, brand).toBeGreaterThanOrEqual(
        0.02
      )
      expect(oklch(palette?.line ?? brand).C, brand).toBeGreaterThanOrEqual(
        0.012
      )
    }
  })

  // The ceiling: the reference's band is oklch(94% .021 146) and its border
  // .012. A crimson's derived tint at C 0.035 and L 0.91 read as a pink band.
  test("a derived tint and line stay quiet", () => {
    const derived = PALETTES.map((each) => paletteFromBrand(each.accent))
    for (const palette of derived) {
      const [tint, line] = [palette?.tint, palette?.line].map((hex) =>
        oklch(hex as string)
      ) as [ReturnType<typeof oklch>, ReturnType<typeof oklch>]
      expect(tint.L, palette?.tint).toBeGreaterThanOrEqual(0.94)
      expect(tint.C, palette?.tint).toBeLessThanOrEqual(0.0235)
      expect(line.C, palette?.line).toBeLessThanOrEqual(0.015)
    }
  })

  test("the theme leads every grey token of tokens.css to the brand", () => {
    const styles = (name: string) =>
      readFileSync(join(ROOT, "src/styles", name), "utf8")
    // tokens.css is the app's too, and its own neutrals are grey on purpose.
    const flat = [
      ...styles("tokens.css").matchAll(
        /--([a-z-]+):\s*oklch\(([\d.]+) ([\d.]+) /g
      ),
    ]
      .filter(([, , , chroma]) => Number(chroma) < 0.01)
      .map(([, name]) => name)
      .filter(
        (name) =>
          !["scan-surface", "rail", "rail-foreground", "field-focus"].includes(
            name ?? ""
          )
      )
    expect(flat.length).toBeGreaterThan(8)
    const theme = styles("theme.css")
    const kept = flat.filter(
      (name) => !new RegExp(`--${name}:\\s*(color-mix|var)`).test(theme)
    )
    expect(kept).toEqual([])
  })
})

// Design rule 7: processes and lists are numbered 01, 02, 03, and a pattern
// built on photos does not show one icon card three times when none came.
describe("numbered lists and photo-less service cards (rule 7)", () => {
  test("every counted list is drawn with leading zeros", () => {
    const css = readFileSync(join(ROOT, "src/styles/site.css"), "utf8")
    const drawn = [
      ...css.matchAll(/([^{}]+)\{([^{}]*content:\s*counter\([^)]*\)[^{}]*)\}/g),
    ]
    const bare = drawn
      .filter(([, , body]) => !body?.includes("decimal-leading-zero"))
      .map(([, selector]) => selector?.trim())
    expect(bare).toEqual([])
    const selectors = drawn.map(([, selector]) => selector).join(" ")
    for (const list of [
      "step-list",
      "service-rows",
      "next-list",
      "offerings",
      "service-detail",
    ]) {
      expect(selectors, list).toContain(list)
    }
  })

  const PHOTOS = {
    service1Image: "/uploads/s1.jpg",
    service1ImageAlt: "A kitchen",
    service2Image: "/uploads/s2.jpg",
    service2ImageAlt: "An oven",
    service3Image: "/uploads/s3.jpg",
    service3ImageAlt: "A hallway",
  }
  const cards = {
    ...layout,
    home: layout.home.map((each) =>
      each.kind === "service_cards" ? { ...each, variant: "photo_cards" } : each
    ),
  }
  const page = (site: Built | undefined, file: string) => {
    if (!site) throw new Error("the build did not run")
    return readPages(site.dist).find((each) => each.file === file)?.html ?? ""
  }
  let none: Built | undefined
  let some: Built | undefined
  let all: Built | undefined
  let direction: Built | undefined
  let pictured: Built | undefined
  beforeAll(async () => {
    ;[none, some, all, direction, pictured] = await Promise.all([
      build({ site: FILLED, layout: cards }),
      build({
        site: {
          ...FILLED,
          service1Image: PHOTOS.service1Image,
          service1ImageAlt: PHOTOS.service1ImageAlt,
        },
        layout: cards,
      }),
      build({ site: { ...FILLED, ...PHOTOS }, layout: cards }),
      build({ site: FILLED }),
      build({ site: { ...FILLED, ...PHOTOS } }),
    ])
  }, 180_000)
  test("a list takes numbers or icons, never both", () => {
    const css = readFileSync(join(ROOT, "src/styles/site.css"), "utf8")
    const counted = [
      ...css.matchAll(/\.([\w-]+)\s*\{[^{}]*counter-reset/g),
    ].map((m) => m[1] ?? "")
    expect(counted).toContain("service-rows")
    const both = [direction, pictured].flatMap((site) =>
      site
        ? readPages(site.dist).flatMap(({ file, html }) =>
            [...html.matchAll(/<(ol|ul) class="([^"]*)">([\s\S]*?)<\/\1>/g)]
              .filter(
                ([, , classes, items]) =>
                  counted.some((each) => classes?.split(" ").includes(each)) &&
                  items?.includes("card-icon")
              )
              .map(([, , classes]) => `${file}: ${classes}`)
          )
        : []
    )
    expect(both).toEqual([])
    const home = page(direction, "index.html")
    expect(home).toContain('class="value-list"')
    expect(home).toContain("card-icon")
  })

  test("photo cards without a photo for every service become numbered rows", () => {
    for (const site of [none, some]) {
      const home = page(site, "index.html")
      expect(home).toContain("services-numbered_rows")
      expect(home).not.toContain("services-photo_cards")
    }
    expect(page(all, "index.html")).toContain("services-photo_cards")
  })

  test("the default alternating pattern needs a photo on the home page, not on a service's own page", () => {
    // FILLED asks for the direction's own pattern, which is alternating.
    expect(page(direction, "index.html")).not.toContain("services-alternating")
    expect(page(direction, "index.html")).toContain("services-numbered_rows")
    expect(page(direction, "services/weekly-clean/index.html")).toContain(
      "services-alternating"
    )
  })

  test("alternating rows off a service's own page point there instead of repeating it", () => {
    const home = page(pictured, "index.html")
    expect(home).toContain("services-alternating")
    expect(home).toContain('href="/services/weekly-clean/"')
    expect(home).toContain('data-copy="service_body"')
    expect(home).not.toContain('data-copy="service_detail"')
    expect(home).not.toContain('data-copy="service_includes"')
    expect(page(pictured, "services/weekly-clean/index.html")).toContain(
      'data-copy="service_includes"'
    )
  })
})
