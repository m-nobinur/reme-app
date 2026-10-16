import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { layout } from "../src/site-config"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

// The inner pages' headers: a page with no photo is one text block, never a
// text column beside an empty one, and no two pages open on the same picture.

/** The blueprint's inner pages name text_led, whose photo is an inset beside the text. */
const withVariant = (variant: string) =>
  Object.fromEntries(
    Object.entries(layout).map(([page, sections]) => [
      page,
      sections.map((s) => (s.kind === "hero" ? { ...s, variant } : s)),
    ])
  ) as unknown as typeof layout
const TEXT_LED = withVariant("text_led")
/** Every hero variant on a page of its own, so one build covers them all with no photo. */
const EACH_VARIANT = Object.fromEntries(
  Object.entries(TEXT_LED).map(([page, sections]) => {
    const variant = {
      about: "wash",
      services: "split_arch",
      service: "split_frame",
      contact: "dark_center",
      quote: "text_led",
    }[page]
    return [
      page,
      variant
        ? sections.map((s) => (s.kind === "hero" ? { ...s, variant } : s))
        : sections,
    ]
  })
) as unknown as typeof layout

const image = (r: number, g: number, b: number) =>
  sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r, g, b } },
  })
    .jpeg()
    .toBuffer()

let bare: Built | undefined
let photos: Built | undefined
let bleed: Built | undefined
beforeAll(async () => {
  const files = {
    "src/assets/uploads/hero.jpg": await image(200, 60, 60),
    "src/assets/uploads/about.jpg": await image(60, 200, 60),
    "src/assets/uploads/weekly.jpg": await image(60, 60, 200),
    "src/assets/photos/one.jpg": await image(200, 200, 60),
  }
  const withPhotos = {
    ...FILLED,
    aboutImage: "/uploads/about.jpg",
    aboutImageAlt: "A hallway in daylight",
    // The home hero's photo again, and the about page's: both must be dropped.
    contactImage: "/uploads/hero.jpg",
    contactImageAlt: "The hero's living room",
    service1HeaderImage: "/uploads/weekly.jpg",
    service1HeaderImageAlt: "A tidy kitchen",
    service2HeaderImage: "/uploads/about.jpg",
    service2HeaderImageAlt: "The about page's hallway",
    // A card's photo is never the header's: service 3 has a card photo only.
    service3Image: "/uploads/weekly.jpg",
    service3ImageAlt: "A card photo",
  }
  ;[bare, photos, bleed] = await Promise.all([
    build({
      site: {
        ...FILLED,
        servicesCtaHeading: "Ready to *book your clean*?",
        // One line repeats a service's name, one is new work.
        offerings: "weekly CLEAN\nOven cleaning",
      },
      layout: EACH_VARIANT,
    }),
    build({
      site: withPhotos,
      layout: TEXT_LED,
      files,
      standIns: false,
    }),
    build({
      site: withPhotos,
      layout: withVariant("dark_center"),
      files,
      standIns: false,
    }),
  ])
}, 240_000)
afterAll(() => {
  clean(bare)
  clean(photos)
  clean(bleed)
})

const headerOf = (html: string) =>
  /<section class="hero[^"]*"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ""
const pagesOf = (built: Built | undefined) => {
  if (!built) throw new Error("the build did not run")
  return readPages(built.dist).filter((p) => p.file !== "404.html")
}
/** The first image a header asks for, which names its photo's file. */
const photoOf = (html: string) =>
  /<img[^>]*\ssrc="([^"]+)"/.exec(headerOf(html))?.[1]

describe("a page header with no photo", () => {
  test("is the plain page header, whatever variant the layout names", () => {
    const inner = pagesOf(bare).filter((p) => p.file !== "index.html")
    expect(inner.length).toBeGreaterThan(5)
    for (const page of inner) {
      const header = headerOf(page.html)
      expect(header, page.file).toContain("hero-page")
      expect(header, page.file).not.toContain("hero-home")
      expect(header, page.file).not.toContain("hero-media")
      // A cover is a header with a drawing; one with nothing in its second column is half empty.
      expect(header.includes("hero-cover"), page.file).toBe(
        header.includes("area-art-cover")
      )
    }
  })

  test("keeps the home hero's own composition", () => {
    const home = pagesOf(bare).find((p) => p.file === "index.html")
    expect(headerOf(home?.html ?? "")).toContain("hero-home")
  })
})

describe("a page header with a photo", () => {
  test("shows the photo in the layout's variant", () => {
    const page = pagesOf(photos).find(
      (p) => p.file === "services/weekly-clean/index.html"
    )
    expect(headerOf(page?.html ?? "")).toContain("hero-media")
    const about = pagesOf(photos).find((p) => p.file === "about/index.html")
    expect(headerOf(about?.html ?? "")).toContain("hero-media")
  })

  // The sources here are 1600 px wide: only the home hero may offer more than 960.
  test("caps every inner page's photos at 960 px, and lets the home hero go past it", () => {
    const widths = (html: string) =>
      [...html.matchAll(/<source[^>]*srcset="([^"]+)"/g)].flatMap((m) =>
        (m[1] ?? "")
          .split(",")
          .map((c) => Number.parseInt(c.trim().split(/\s+/)[1] ?? "", 10))
      )
    const pages = pagesOf(photos)
    const inner = pages.filter((p) => p.file !== "index.html")
    expect(inner.flatMap((p) => widths(p.html)).length).toBeGreaterThan(0)
    for (const page of inner) {
      expect(Math.max(0, ...widths(page.html)), page.file).toBeLessThanOrEqual(
        960
      )
    }
    const home = pages.find((p) => p.file === "index.html")
    expect(Math.max(...widths(home?.html ?? ""))).toBeGreaterThan(960)
  })

  test("offers a full-bleed header up to its source width, and still holds every other photo to 960", () => {
    const widths = (html: string) =>
      [...html.matchAll(/<source[^>]*srcset="([^"]+)"/g)].flatMap((m) =>
        (m[1] ?? "")
          .split(",")
          .map((c) => Number.parseInt(c.trim().split(/\s+/)[1] ?? "", 10))
      )
    const about = pagesOf(bleed).find((p) => p.file === "about/index.html")
    expect(headerOf(about?.html ?? "")).toContain("hero-dark_center")
    expect(Math.max(...widths(headerOf(about?.html ?? "")))).toBe(1600)
    // The services page shows a card photo: not a header, so 960.
    for (const page of pagesOf(bleed).filter((p) => p.file !== "index.html")) {
      const rest = page.html.replace(headerOf(page.html), "")
      expect(Math.max(0, ...widths(rest)), page.file).toBeLessThanOrEqual(960)
    }
  })

  test("never repeats the home hero's photo or another header's", () => {
    const pages = pagesOf(photos)
    const shown = pages
      .map((p) => [p.file, photoOf(p.html)] as const)
      .filter(([, src]) => src)
    // Home, about and the first service have one each; the contact and second service pages asked for a repeat.
    expect(
      shown.map(([file]) => file).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      "about/index.html",
      "index.html",
      "services/weekly-clean/index.html",
    ])
    expect(new Set(shown.map(([, src]) => src)).size).toBe(shown.length)
    for (const file of [
      "contact/index.html",
      "services/deep-clean/index.html",
      // Only a card photo: the header is the text one, not the card's picture.
      "services/end-of-tenancy/index.html",
    ]) {
      const header = headerOf(pages.find((p) => p.file === file)?.html ?? "")
      expect(header, file).toContain("hero-page")
      expect(header, file).not.toContain("<img")
    }
  })
})

describe("an accent clause before punctuation", () => {
  test("leaves no space between the clause and the question mark", () => {
    const html = pagesOf(bare).find((p) => p.file === "services/index.html")
    expect(html?.html).toContain("book your clean</span>?")
  })
})

describe("the services page's offerings", () => {
  test("leave out a line that only repeats a service's name", () => {
    if (!bare) throw new Error("the build did not run")
    const html =
      readPages(bare.dist).find((p) => p.file === "services/index.html")
        ?.html ?? ""
    const list = /<ol class="offerings">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? ""
    expect(list).toContain("Oven cleaning")
    expect(list.toLowerCase()).not.toContain("weekly clean")
  })
})

describe("the About story's photo", () => {
  test("shows under a text header, and goes when the header opens on a photo", () => {
    const about = (built: Built | undefined) =>
      pagesOf(built).find((p) => p.file === "about/index.html")?.html ?? ""
    expect(about(bare)).toContain("story-photo")
    expect(headerOf(about(photos))).toContain("hero-media")
    expect(about(photos)).not.toContain("story-photo")
  })
})
