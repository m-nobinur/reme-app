import { beforeAll, describe, expect, test } from "vitest"
import { layout } from "../src/page-fields"
import { seedDocuments } from "../src/page-seed"
import { type Built, build, readPages } from "./build"
import { FILLED } from "./fixture"

type Doc = {
  sections: {
    id: string
    kind: string
    blocks?: {
      id: string
      type: string
      provenance: string
      [k: string]: unknown
    }[]
  }[]
}

const prose = (id: string, provenance = "trade") => ({
  id,
  type: "prose",
  provenance,
  markdown: `Words for ${id}.`,
})

const planted = (docs: Record<string, Doc>) =>
  Object.fromEntries(
    Object.entries(docs).map(([path, body]) => [
      `src/content/pages/${path}`,
      new TextEncoder().encode(JSON.stringify(body)),
    ])
  )

const doc = (path: string) => {
  const found = seedDocuments(FILLED, layout, true)[path] as Doc | undefined
  if (!found) throw new Error(`the seed has no ${path}`)
  return found
}

const main = (html: string) =>
  html.replace(/<(header|footer)[\s\S]*?<\/\1>/g, "")

const CARD_LINE = "Right around the corner"

let built: Built
let pages: ReturnType<typeof readPages>
beforeAll(async () => {
  const service = doc("services/weekly-clean.json")
  service.sections.push({
    id: "extra",
    kind: "content",
    blocks: [prose("a"), prose("b"), prose("c")],
  })
  const services = doc("services.json")
  services.sections.push({
    id: "extra",
    kind: "content",
    blocks: [
      {
        id: "table",
        type: "table",
        provenance: "facts",
        columns: ["Service", "Covers"],
        rows: [["Weekly clean", "Surfaces"]],
      },
    ],
  })
  built = await build({
    site: { ...FILLED, areaTowns: "", areaCardLine: CARD_LINE },
    layout,
    files: planted({
      "services/weekly-clean.json": service,
      "services.json": services,
    }),
  })
  pages = readPages(built.dist)
}, 120_000)

const page = (file: string) =>
  pages.find((each) => each.file === file)?.html ?? ""

describe("each thing once", () => {
  test("the area line is the service area page's, not every page's footer", () => {
    const saying = pages
      .filter((each) =>
        each.texts.some((text) => text.trim() === FILLED.serviceAreaText)
      )
      .map((each) => each.file)
    expect(saying).toEqual(["service-area/index.html"])
  })

  test("the area card's line is the home page's, not the service area page's too", () => {
    const saying = pages
      .filter((each) => each.html.includes(CARD_LINE))
      .map((each) => each.file)
    expect(saying).toEqual(["index.html"])
  })

  test("the typical-scope note shows once on a page, however many trade blocks it has", () => {
    const html = page("services/weekly-clean/index.html")
    expect(html.match(/class="block block-prose"/g)?.length).toBeGreaterThan(2)
    expect(html.match(/class="typical-note"/g)).toHaveLength(1)
  })

  test("the services page leaves a service's card text to the home page when its table says the rest", () => {
    expect(main(page("index.html"))).toContain(FILLED.service1Body)
    expect(main(page("services/index.html"))).not.toContain(FILLED.service1Body)
  })
})
