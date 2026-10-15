import { existsSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { layout } from "../src/site-config"
import { type Built, build, clean, type Page, readPages } from "./build"
import { FILLED } from "./fixture"

const image = (w: number, h: number) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 122, g: 154, b: 128 },
    },
  })
    .jpeg()
    .toBuffer()

/** FILLED names a logo it ships no file for; `photos` ships it and service 1's photo. */
let bare: Built | undefined
let photos: Built | undefined
let rows: Built | undefined
beforeAll(async () => {
  ;[bare, rows, photos] = await Promise.all([
    build({ site: FILLED, standIns: false }),
    // The reference run's Blueprint gave a service page numbered rows, which dropped both blocks.
    build({
      site: FILLED,
      standIns: false,
      layout: {
        ...layout,
        service: [
          { kind: "hero" },
          { kind: "service_cards", variant: "numbered_rows" },
          { kind: "faq" },
          { kind: "cta_band" },
        ],
      },
    }),
    build({
      site: {
        ...FILLED,
        service1HeaderImage: "/uploads/weekly.jpg",
        service1HeaderImageAlt: "A tidy kitchen after a weekly clean",
      },
      files: {
        "src/assets/uploads/logo.png": await sharp(await image(320, 120))
          .png()
          .toBuffer(),
        "src/assets/uploads/weekly.jpg": await image(1600, 1200),
      },
    }),
  ])
}, 180_000)
afterAll(() => {
  clean(bare)
  clean(rows)
  clean(photos)
})

const pagesOf = (built: Built | undefined) => {
  if (!built) throw new Error("the build did not run")
  return readPages(built.dist)
}
/** Every URL an <img> or <source> asks for: its src and each srcset candidate. */
const imageUrls = (page: Page) =>
  page.elements
    .filter((el) => el.tag === "img" || el.tag === "source")
    .flatMap((el) => [
      ...(el.attrs.src ? [el.attrs.src] : []),
      ...(el.attrs.srcset ?? "")
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
        .filter(Boolean),
    ])

describe("a service page's included and who-it-suits blocks", () => {
  test.each([
    ["the default layout", () => bare],
    ["a layout that asks for numbered rows", () => rows],
  ])("show on every service page with %s", (_name, get) => {
    const pages = pagesOf(get()).filter((p) =>
      /^services\/[^/]+\/index\.html$/.test(p.file)
    )
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page.html, page.file).toContain('data-copy="service_includes"')
      expect(page.html, page.file).toContain('data-copy="service_for"')
      expect(page.html, page.file).toContain("What is included")
      expect(page.html, page.file).toContain("Who it is for")
    }
  })

  test("show the service's own words", () => {
    const html =
      pagesOf(rows).find((p) => p.file === "services/weekly-clean/index.html")
        ?.html ?? ""
    expect(html).toContain(FILLED.service1For)
  })

  // The confirming run's first copy gate: every service page's h2 was its
  // bare name, a repeat of the home page's and the services page's.
  test("never repeat the service's name as an h2 under the h1 that names it", () => {
    const html =
      pagesOf(bare).find((p) => p.file === "services/weekly-clean/index.html")
        ?.html ?? ""
    expect(html).toContain(`<h1`)
    expect(html).not.toMatch(
      new RegExp(`<h2[^>]*>\\s*${FILLED.service1Name}\\s*</h2>`)
    )
  })
})

describe("built images", () => {
  test("every image a page asks for is a file in dist", () => {
    for (const built of [bare, photos]) {
      if (!built) throw new Error("the build did not run")
      const missing = readPages(built.dist).flatMap((page) =>
        imageUrls(page)
          .filter(
            (url) =>
              !existsSync(
                join(built.dist, decodeURIComponent(url.split("?")[0] ?? ""))
              )
          )
          .map((url) => `${page.file}: ${url}`)
      )
      expect(missing).toEqual([])
    }
  })

  test("a logo field with no file shows the business name, on nested pages too", () => {
    for (const file of ["index.html", "services/weekly-clean/index.html"]) {
      const html = pagesOf(bare).find((p) => p.file === file)?.html ?? ""
      expect(html, file).not.toContain('class="site-logo"')
      expect(html, file).toContain(`>${FILLED.businessName}`)
    }
  })
})

describe("a service page's header", () => {
  const html = (file: string) =>
    pagesOf(photos).find((p) => p.file === file)?.html ?? ""

  test("shows the service's photo, eager and first, and once", () => {
    const page = html("services/weekly-clean/index.html")
    const hero = page.match(
      /<section class="hero[^"]*"[\s\S]*?<\/section>/
    )?.[0]
    expect(hero).toContain("hero-photo")
    expect(hero).toContain('alt="A tidy kitchen after a weekly clean"')
    expect(hero).toMatch(/loading="eager"/)
    expect(hero).toMatch(/fetchpriority="high"/)
    expect(page).toMatch(/<link rel="preload" as="image"/)
    // The detail below does not show it again.
    expect(page).not.toContain('class="service-photo"')
  })

  test("keeps the text header for a service with no photo", () => {
    const hero = html("services/deep-clean/index.html").match(
      /<section class="hero[^"]*"/
    )?.[0]
    expect(hero).toContain("hero-page")
    expect(hero).not.toContain("hero-photo")
  })
})
