import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { layout } from "../src/site-config"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

// The inner pages' headers: a page with no photo is one text block, never a
// text column beside an empty one, and no two pages open on the same picture.

/** The blueprint's inner pages name text_led, whose photo is an inset beside the text. */
const TEXT_LED = Object.fromEntries(
  Object.entries(layout).map(([page, sections]) => [
    page,
    sections.map((s) =>
      s.kind === "hero" ? { ...s, variant: "text_led" } : s
    ),
  ])
) as unknown as typeof layout

const image = (r: number, g: number, b: number) =>
  sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r, g, b } },
  })
    .jpeg()
    .toBuffer()

let bare: Built | undefined
let photos: Built | undefined
beforeAll(async () => {
  const files = {
    "src/assets/uploads/hero.jpg": await image(200, 60, 60),
    "src/assets/uploads/about.jpg": await image(60, 200, 60),
    "src/assets/uploads/weekly.jpg": await image(60, 60, 200),
  }
  ;[bare, photos] = await Promise.all([
    build({
      site: { ...FILLED, servicesCtaHeading: "Ready to *book your clean*?" },
      layout: TEXT_LED,
    }),
    build({
      site: {
        ...FILLED,
        aboutImage: "/uploads/about.jpg",
        aboutImageAlt: "A hallway in daylight",
        // The home hero's photo again, and the about page's: both must be dropped.
        contactImage: "/uploads/hero.jpg",
        contactImageAlt: "The hero's living room",
        service1Image: "/uploads/weekly.jpg",
        service1ImageAlt: "A tidy kitchen",
        service2Image: "/uploads/about.jpg",
        service2ImageAlt: "The about page's hallway",
      },
      layout: TEXT_LED,
      files,
      standIns: false,
    }),
  ])
}, 240_000)
afterAll(() => {
  clean(bare)
  clean(photos)
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
