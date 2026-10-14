import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Built, build, clean, readPages } from "./build"
import { FILLED } from "./fixture"

const NOTICE =
  "Authorised and regulated by the Fairhaven Law Society. Reg. 4471."

describe("the footer's regulatory notice", () => {
  const built: Partial<Record<string, Built>> = {}

  beforeAll(async () => {
    const [none, some] = await Promise.all([
      build({ site: { ...FILLED, disclaimer: "" } }),
      build({ site: { ...FILLED, disclaimer: NOTICE } }),
    ])
    Object.assign(built, { none, some })
  }, 180_000)

  afterAll(() => {
    for (const each of Object.values(built)) clean(each)
  })

  const footerTexts = (name: string) =>
    readPages(built[name]?.dist ?? "").flatMap((page) =>
      page.elements.some(
        (el) => el.tag === "p" && el.attrs.class === "footer-disclaimer"
      )
        ? page.texts.filter((text) => text.includes("regulated"))
        : []
    )

  test("renders on every page from the field alone", () => {
    const pages = readPages(built.some?.dist ?? "")
    expect(pages.length).toBeGreaterThan(1)
    expect(footerTexts("some")).toHaveLength(pages.length)
  })

  test("renders nothing when the field is empty", () => {
    for (const page of readPages(built.none?.dist ?? ""))
      expect(page.html).not.toContain("footer-disclaimer")
  })
})
