import { beforeAll, describe, expect, test } from "vitest"
import { type Built, build, readPages } from "./build"
import { FILLED } from "./fixture"

describe("the footer's labels", () => {
  let built: Built | undefined
  beforeAll(async () => {
    built = await build({
      site: {
        ...FILLED,
        footerPagesHeading: "Pages",
        footerContactHeading: "Get in touch",
      },
    })
  }, 180_000)

  test("are paragraphs on every page, so no h2 repeats across the site", () => {
    const pages = readPages(built?.dist ?? "")
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      const labels = page.elements.filter(
        (el) => el.attrs.class === "footer-heading"
      )
      expect(labels.length, page.file).toBeGreaterThan(0)
      for (const label of labels) expect(label.tag, page.file).toBe("p")
    }
  })
})

describe("the footer's blurb", () => {
  const blurbs = async (site: Record<string, string>) =>
    readPages((await build({ site })).dist).flatMap((page) =>
      [...page.html.matchAll(/<p class="footer-blurb"[^>]*>([^<]*)</g)].map(
        (match) => match[1]
      )
    )
  const intro = "A hero subhead that runs on for a sentence or two."

  test("is its own line, never the hero's subhead", async () => {
    const own = await blurbs({
      ...FILLED,
      homeIntro: intro,
      tagline: "",
      footerBlurb: "Cleaning you can rely on.",
    })
    expect(own.length).toBeGreaterThan(0)
    expect(new Set(own)).toEqual(new Set(["Cleaning you can rely on."]))
    expect(await blurbs({ ...FILLED, homeIntro: intro, tagline: "" })).toEqual(
      []
    )
  }, 180_000)

  test("falls back to the tagline when it says the service area", async () => {
    const shown = await blurbs({
      ...FILLED,
      footerBlurb: `Home cleaning across ${FILLED.serviceAreaText}.`,
    })
    expect(shown.length).toBeGreaterThan(0)
    expect(new Set(shown)).toEqual(new Set([FILLED.tagline]))
  }, 180_000)
})
