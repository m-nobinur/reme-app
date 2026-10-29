/**
 * The accessibility gate for a tenant site: axe against the built pages of the
 * golden fixture, in a real browser, at WCAG 2.2 AA, in three directions.
 *
 * It is vitest rather than a Playwright runner so that scripts/floor.mjs can
 * count it, and it lives outside `test/` so that `pnpm test` stays browser-free
 * and CI, which installs no browser, keeps running. Run it with
 * `pnpm --filter @workspace/starter-site test:a11y`.
 *
 * The pages are served over HTTP rather than opened from disk; see serve in
 * test/build.ts.
 */

import type { Server } from "node:http"
import AxeBuilder from "@axe-core/playwright"
import { type Browser, chromium, type Page } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { afterAll, beforeAll, expect, test } from "vitest"
import { type Built, build, serve } from "../test/build"
import { FILLED, LIMOUSINE_FORM } from "../test/fixture"

const PAGES = [
  "/",
  "/about/",
  "/services/",
  "/service-area/",
  "/contact/",
  "/quote/",
]
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

/** Three directions, each in a palette and a font of its own. */
const brand = (id: string) =>
  PALETTES.find((each) => each.id === id)?.brand ?? ""
const VARIANTS: Record<string, Record<string, string>> = {
  fresh_modern: {
    ...FILLED,
    direction: "fresh_modern",
    brandColor: brand("forest"),
  },
  calm_daylight: {
    ...FILLED,
    direction: "calm_daylight",
    brandColor: brand("sunset"),
    font: "classic_serif",
  },
  after_dark: {
    ...FILLED,
    direction: "after_dark",
    brandColor: brand("midnight"),
    font: "soft_rounded",
  },
}

const sites: { name: string; built: Built; server: Server; origin: string }[] =
  []
let browser: Browser | undefined
let page: Page | undefined
/** A phone-width page, where the menu and the stacked heroes show. */
let phone: Page | undefined

beforeAll(async () => {
  for (const [name, site] of Object.entries(VARIANTS)) {
    // The after_dark build asks a chauffeur firm's questions, so a select, a
    // number and a date are scanned as well as the default text inputs.
    const built = await build({
      site,
      ...(name === "after_dark" ? { quoteForm: LIMOUSINE_FORM } : {}),
    })
    sites.push({ name, built, ...(await serve(built.dist)) })
  }
  browser = await chromium.launch()
  // A context of its own: axe refuses a page made straight off the browser.
  // Reduced motion, as the build's scan sets it: axe reads text mid fade-in
  // as faint. a11y/motion.test.ts covers the fade itself.
  page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage()
  phone = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    })
  ).newPage()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  for (const site of sites) site.server.close()
})

const WIDTHS = [
  { label: "", at: () => page },
  { label: " at phone width, menu open", at: () => phone },
]

for (const name of Object.keys(VARIANTS)) {
  for (const path of PAGES) {
    for (const width of WIDTHS) {
      test(`${name} ${path}${width.label} has no accessibility violations`, async () => {
        const site = sites.find((each) => each.name === name)
        const tab = width.at()
        if (!tab || !site)
          throw new Error("the browser or the build did not start")
        await tab.goto(`${site.origin}${path}`)
        if (tab === phone) await tab.locator(".nav-narrow summary").click()
        const results = await new AxeBuilder({ page: tab })
          .withTags(TAGS)
          .analyze()
        expect(
          results.violations.map((violation) => violation.id),
          JSON.stringify(results.violations, null, 2)
        ).toEqual([])
      }, 60_000)
    }
  }
}
