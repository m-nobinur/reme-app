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
