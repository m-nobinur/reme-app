/**
 * axe at WCAG 2.2 AA over every section variant: test/catalog.astro planted
 * into a build of the fictional fixture, with the photo fields the variants
 * read filled, at desktop and at phone width. Run it with
 * `pnpm --filter @workspace/starter-site exec vitest run a11y/variants.test.ts`.
 */

import { readFileSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { type Browser, chromium } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { afterAll, beforeAll, expect, test } from "vitest"
import { type Built, build, clean, ROOT, serve } from "../test/build"
import { FILLED } from "../test/fixture"

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

/** The fixture, with every photo a variant can show. Fictional paths. */
const SITE: Record<string, string> = {
  ...FILLED,
  brandColor: PALETTES.find((each) => each.id === "forest")?.brand ?? "",
  heroCaption: "Fully insured",
  ctaImage: "/photos/two.jpg",
  ...Object.fromEntries(
    [1, 2, 3].flatMap((n) => [
      [`service${n}Image`, `/photos/service-${n}.jpg`],
      [`service${n}ImageAlt`, `A room after a ${FILLED[`service${n}Name`]}`],
    ])
  ),
}

let built: Built | undefined
let server: Server | undefined
let origin = ""
let browser: Browser | undefined

beforeAll(async () => {
  const catalog = readFileSync(join(ROOT, "test/catalog.astro"), "utf8")
  built = await build({
    site: SITE,
    pages: { "catalog.astro": catalog.replaceAll('"../src/', '"../') },
  })
  ;({ server, origin } = await serve(built.dist))
  browser = await chromium.launch()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  clean(built)
})

for (const width of [1440, 390]) {
  test(`every section variant at ${width} px has no accessibility violations`, async () => {
    if (!browser) throw new Error("the browser did not start")
    const page = await (
      await browser.newContext({ viewport: { width, height: 900 } })
    ).newPage()
    await page.goto(`${origin}/catalog/`)
    // Every variant rendered, so a variant that silently renders nothing
    // cannot pass by being absent.
    for (const name of [
      "hero-wash",
      "hero-split_arch",
      "hero-split_frame",
      "hero-dark_center",
      "hero-text_led",
      "services-photo_cards",
      "services-numbered_rows",
      "services-alternating",
      "services-fleet",
      "services-practice_list",
      "steps-circles",
      "steps-dark_band",
      "steps-timeline",
      "faq-split",
      "faq-stacked",
      "cta-photo",
      "trust-strip",
      "testimonials-featured",
      "testimonials-wall",
      "header-centered",
      "header-minimal",
    ])
      expect(await page.locator(`.${name}`).count(), name).toBeGreaterThan(0)
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(
      results.violations.map((violation) => violation.id),
      JSON.stringify(results.violations, null, 2)
    ).toEqual([])
  }, 120_000)
}
