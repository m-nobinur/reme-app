import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BLOCK_TYPES, PageDocument } from "@workspace/contracts"
import { beforeAll, describe, expect, it } from "vitest"
import { layout } from "../src/page-fields"
import { seedDocuments } from "../src/page-seed"
import { everyBlockFiles, json, owner } from "./blocks"
import { type Built, build, jsonLdOf, ROOT, readPages } from "./build"
import { FILLED } from "./fixture"

describe("the starter's copy of the schema", () => {
  it("is the contract's file with zod from astro", () => {
    const starter = readFileSync(join(ROOT, "src/page-document.ts"), "utf8")
    const contract = readFileSync(
      join(ROOT, "../contracts/src/page.ts"),
      "utf8"
    )
    expect(starter.replace('from "astro/zod"', 'from "zod"')).toBe(contract)
  })
})

describe("the seed", () => {
  it("makes a valid document of every page, the services' included", () => {
    const docs = seedDocuments(FILLED, layout, true)
    expect(Object.keys(docs)).toEqual(
      expect.arrayContaining([
        "home.json",
        "service-area.json",
        "services/deep-clean.json",
      ])
    )
    for (const [path, doc] of Object.entries(docs))
      expect(PageDocument.safeParse(doc).error, path).toBeUndefined()
  })
})

describe("a page document", () => {
  let built: Built
  let home: ReturnType<typeof readPages>[number]
  beforeAll(async () => {
    built = await build({ site: FILLED, files: await everyBlockFiles() })
    const found = readPages(built.dist).find((p) => p.file === "index.html")
    if (!found) throw new Error("no home page")
    home = found
  }, 120_000)

  it("renders a block of every type", () => {
    const classes = home.elements.map((e) => e.attrs.class ?? "")
    for (const type of BLOCK_TYPES)
      expect(
        classes.some((c) => c.split(" ").includes(`block-${type}`)),
        type
      ).toBe(true)
    expect(home.texts).toEqual(
      expect.arrayContaining([
        "Inside the oven",
        "Deep clean",
        "Keys by arrangement.",
        "Spotless.",
        "Book now",
        "After",
      ])
    )
    expect(home.elements.some((e) => e.tag === "table")).toBe(true)
    expect(
      home.elements.some(
        (e) => e.tag === "img" && e.attrs.alt === "A clean kitchen"
      )
    ).toBe(true)
  })

  it("keeps a section that gives no words on the seed's, and the title too", () => {
    const h1 = home.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ""
    expect(h1.replace(/<[^>]+>/g, "")).toContain(FILLED.heroHeading)
    expect(home.texts).toContain(FILLED.faq1Question)
    expect(home.html).toContain(`<title>${FILLED.homeTitle}</title>`)
  })

  it("shows a tag as text and drops a script link", () => {
    expect(home.scripts.some((s) => s.body.includes("alert(1)"))).toBe(false)
    expect(home.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(
      home.elements.some((e) => /javascript:/i.test(e.attrs.href ?? ""))
    ).toBe(false)
    expect(
      home.elements.some((e) => e.tag === "a" && e.attrs.href === "/contact/")
    ).toBe(true)
  })

  it("renders the custom section it places, with its blocks", () => {
    expect(home.texts).toEqual(
      expect.arrayContaining(["A note from us", "Closed on bank holidays."])
    )
  })

  it("puts its FAQ blocks' questions in FAQPage", () => {
    const faq = jsonLdOf(home).find((thing) => thing["@type"] === "FAQPage")
    const names = ((faq?.mainEntity ?? []) as { name: string }[]).map(
      (q) => q.name
    )
    expect(names).toEqual(
      expect.arrayContaining(["Is the oven included?", FILLED.faq1Question])
    )
  })
})

describe("a document that is not one", () => {
  it.each([
    [
      "an unknown block type",
      {
        page: "home",
        sections: [
          {
            id: "a",
            kind: "content",
            blocks: [{ ...owner, id: "b", type: "html", html: "<b>" }],
          },
        ],
      },
    ],
    [
      "a custom section with no file",
      {
        page: "home",
        sections: [{ id: "a", kind: "custom", name: "Missing", blocks: [] }],
      },
    ],
  ])(
    "fails the build: %s",
    async (_, doc) => {
      await expect(
        build({
          site: FILLED,
          files: { "src/content/pages/home.json": json(doc) },
        })
      ).rejects.toThrow(/home/)
    },
    120_000
  )
})
