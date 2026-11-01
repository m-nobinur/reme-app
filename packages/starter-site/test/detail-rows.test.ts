import { beforeAll, expect, test } from "vitest"
import { layout } from "../src/page-fields"
import { seedDocuments } from "../src/page-seed"
import { type Built, build, readPages } from "./build"
import { FILLED } from "./fixture"

let built: Built
beforeAll(async () => {
  const services = seedDocuments(FILLED, layout, true)["services.json"] as {
    sections: { kind: string; variant?: string }[]
  }
  for (const section of services.sections)
    if (section.kind === "service_cards") section.variant = "alternating"
  built = await build({
    site: FILLED,
    layout,
    files: {
      "src/content/pages/services.json": new TextEncoder().encode(
        JSON.stringify(services)
      ),
    },
  })
}, 120_000)

const rows = (file: string) =>
  readPages(built.dist)
    .find((each) => each.file === file)
    ?.html.match(/<div class="service-detail-main">[\s\S]*?<\/div>/g) ?? []

// Design rule 7: a list takes numbers or icons, never both.
test("detail rows are numbered on the services page and carry no icon there", () => {
  const listed = rows("services/index.html")
  expect(listed.length).toBeGreaterThan(1)
  for (const row of listed) expect(row).not.toContain('class="mark"')
})

test("a service's own page has no list to number, so it keeps its icon", () => {
  expect(rows("services/weekly-clean/index.html")[0]).toContain('class="mark"')
})
