/**
 * The accessibility gate for a tenant site: axe against the built pages of the
 * golden fixture, in a real browser, at WCAG 2.2 AA, once per template.
 *
 * It is vitest rather than a Playwright runner so that scripts/floor.mjs can
 * count it, and it lives outside `test/` so that `pnpm test` stays browser-free
 * and CI, which installs no browser, keeps running. Run it with
 * `pnpm --filter @workspace/starter-site test:a11y`.
 *
 * The pages are served over HTTP rather than opened from disk: the stylesheet
 * is linked absolutely, and a file:// page loads none of it, which is the one
 * thing a contrast check cannot do without.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { type Browser, chromium, type Page } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { afterAll, beforeAll, expect, test } from "vitest"
import { type Built, build, clean } from "../test/build"
import { FILLED } from "../test/fixture"

const PAGES = ["/", "/services/", "/contact/", "/quote/"]
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

/** Each template, each in a palette and a font of its own. */
const brand = (id: string) =>
  PALETTES.find((each) => each.id === id)?.brand ?? ""
const VARIANTS: Record<string, Record<string, string>> = {
  classic: { ...FILLED, template: "classic", brandColor: brand("forest") },
  modern: {
    ...FILLED,
    template: "modern",
    brandColor: brand("sunset"),
    font: "classic_serif",
  },
  bold: {
    ...FILLED,
    template: "bold",
    brandColor: brand("midnight"),
    font: "soft_rounded",
  },
}

const sites: { name: string; built: Built; server: Server; origin: string }[] =
  []
let browser: Browser | undefined
let page: Page | undefined

function serve(dist: string): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://site.invalid").pathname
    const file = join(dist, path.endsWith("/") ? `${path}index.html` : path)
    if (
      !file.startsWith(dist) ||
      !existsSync(file) ||
      statSync(file).isDirectory()
    ) {
      response.writeHead(404).end()
      return
    }
    const type = TYPES[file.slice(file.lastIndexOf("."))]
    response.writeHead(200, type ? { "Content-Type": type } : {})
    response.end(readFileSync(file))
  })
}

beforeAll(async () => {
  for (const [name, site] of Object.entries(VARIANTS)) {
    const built = await build({ site })
    const server = serve(built.dist)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    sites.push({ name, built, server, origin: `http://127.0.0.1:${port}` })
  }
  browser = await chromium.launch()
  // A context of its own: axe refuses a page made straight off the browser.
  page = await (await browser.newContext()).newPage()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  for (const site of sites) {
    site.server.close()
    clean(site.built)
  }
})

for (const name of Object.keys(VARIANTS)) {
  for (const path of PAGES) {
    test(`${name} ${path} has no accessibility violations`, async () => {
      const site = sites.find((each) => each.name === name)
      if (!page || !site)
        throw new Error("the browser or the build did not start")
      await page.goto(`${site.origin}${path}`)
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(
        results.violations.map((violation) => violation.id),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([])
    }, 60_000)
  }
}
