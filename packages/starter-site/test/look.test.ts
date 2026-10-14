import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { accentParts, plain } from "../src/accent"
import { type Built, build, clean, readPages } from "./build"
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
] as const
const MARKED = {
  ...FILLED,
  ...Object.fromEntries(HEADINGS.map((key) => [key, `Plain words, *${key}*`])),
}

let built: Built | undefined
beforeAll(async () => {
  built = await build({ site: MARKED })
}, 120_000)
afterAll(() => clean(built))

const sectionsOf = (html: string) =>
  [...html.matchAll(/<section[\s>][\s\S]*?<\/section>/g)].map(
    (match) => match[0]
  )

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
        .filter((section) => section.includes("<h2"))
        .filter((section) => !section.includes('class="eyebrow"'))
        .map((section) => `${page.file}: ${section.slice(0, 80)}`)
    )
    expect(bare).toEqual([])
  })

  test("every section heading field can set a clause in the accent", () => {
    if (!built) throw new Error("the build did not run")
    const pages = readPages(built.dist)
    const plainH2 = pages.flatMap((page) =>
      sectionsOf(page.html).flatMap((section) =>
        // A service's own name on the services page is an item, not a heading field.
        [
          ...section
            .replace(/<article[\s\S]*?<\/article>/g, "")
            .matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g),
        ]
          .filter(([, inner]) => !inner?.includes('class="accent"'))
          .map(([, inner]) => `${page.file}: ${inner}`)
      )
    )
    expect(plainH2).toEqual([])
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
