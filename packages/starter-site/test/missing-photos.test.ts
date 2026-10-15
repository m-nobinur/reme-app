import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { layout } from "../src/site-config"
import { type Built, build, clean, type Page, readPages } from "./build"
import { FILLED } from "./fixture"

// Every section that has a photo form names a photo here, in its photo
// variant. `present` builds with a file for each; `missing` names the same
// paths with no file behind them, as a slot whose photo was never made.
const SITE = {
  ...FILLED,
  ctaImage: "/uploads/cta.jpg",
  service1Image: "/uploads/s1.jpg",
  service1ImageAlt: "A kitchen after a weekly clean",
  service2Image: "/uploads/s2.jpg",
  service2ImageAlt: "An oven after a deep clean",
  service3Image: "/uploads/s3.jpg",
  service3ImageAlt: "An empty flat after an end of tenancy clean",
}
const LAYOUT = {
  ...layout,
  home: [
    { kind: "hero" as const, variant: "split_frame" },
    { kind: "service_cards" as const, variant: "photo_cards" },
    { kind: "gallery" as const },
    { kind: "cta_band" as const, variant: "photo" },
  ],
}

let present: Built | undefined
let missing: Built | undefined
beforeAll(async () => {
  ;[present, missing] = await Promise.all([
    build({ site: SITE, layout: LAYOUT }),
    build({ site: SITE, layout: LAYOUT, standIns: false }),
  ])
}, 180_000)
afterAll(() => {
  clean(present)
  clean(missing)
})

const page = (built: Built | undefined, file: string): Page => {
  if (!built) throw new Error("the build did not run")
  const found = readPages(built.dist).find((p) => p.file === file)
  if (!found) throw new Error(`no ${file}`)
  return found
}
const classes = (p: Page) =>
  p.elements.flatMap((el) => (el.attrs.class ?? "").split(" "))
const imgs = (p: Page) => p.elements.filter((el) => el.tag === "img")

describe("a section whose photo file is missing takes its text form", () => {
  test("the hero: the plain form with the services, no photo frame", () => {
    expect(classes(page(present, "index.html"))).toContain("hero-photo")
    const home = classes(page(missing, "index.html"))
    expect(home).toContain("hero-plain")
    expect(home).not.toContain("hero-photo")
    expect(home).not.toContain("hero-media")
    expect(home).toContain("hero-list")
  })

  test("the service cards: numbered rows, no card frames", () => {
    expect(classes(page(present, "index.html"))).toContain(
      "services-photo_cards"
    )
    const home = classes(page(missing, "index.html"))
    expect(home).toContain("services-numbered_rows")
    expect(home).not.toContain("card-media")
  })

  test("the gallery: left out, no empty tiles", () => {
    expect(classes(page(present, "index.html"))).toContain("gallery")
    const home = classes(page(missing, "index.html"))
    expect(home).not.toContain("gallery")
    expect(home.some((c) => c.startsWith("gallery-"))).toBe(false)
  })

  test("the about story: one column, no photo frame", () => {
    expect(classes(page(present, "about/index.html"))).toContain("story-split")
    const about = classes(page(missing, "about/index.html"))
    expect(about).toContain("story-inner")
    expect(about).not.toContain("story-split")
    expect(about).not.toContain("story-photo")
  })

  test("the closing band: solid, no photo under it", () => {
    expect(classes(page(present, "index.html"))).toContain("cta-photo")
    const home = classes(page(missing, "index.html"))
    expect(home).toContain("cta-band")
    expect(home).not.toContain("cta-photo")
    expect(home).not.toContain("cta-image")
  })

  test("no page asks for an image at all", () => {
    if (!missing) throw new Error("the build did not run")
    const asked = readPages(missing.dist).flatMap((p) =>
      imgs(p)
        .filter((el) => !el.attrs.src?.endsWith("favicon.svg"))
        .map((el) => `${p.file}: ${el.attrs.src}`)
    )
    expect(asked).toEqual([])
  })
})
