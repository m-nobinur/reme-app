import { existsSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
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
beforeAll(async () => {
  ;[bare, photos] = await Promise.all([
    build({ site: FILLED, standIns: false }),
    build({
      site: {
        ...FILLED,
        service1Image: "/uploads/weekly.jpg",
        service1ImageAlt: "A tidy kitchen after a weekly clean",
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
