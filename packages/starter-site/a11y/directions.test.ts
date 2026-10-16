/**
 * axe at WCAG 2.2 AA over every design direction: the fictional fixture built
 * once per direction, in its own pair and the first of its palettes as
 * site.palette carries it, with every photo slot filled. Each build's home
 * page is that direction's catalog page: every section the home layout
 * holds, in the direction's variants, radius, bands and ornament. Desktop and
 * phone. Run it with
 * `pnpm --filter @workspace/starter-site exec vitest run a11y/directions.test.ts`.
 */

import type { Server } from "node:http"
import AxeBuilder from "@axe-core/playwright"
import { type Browser, chromium } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { afterAll, beforeAll, expect, test } from "vitest"
import { DIRECTIONS } from "../src/directions"
import { type Built, build, clean, serve } from "../test/build"
import { FILLED } from "../test/fixture"

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
const ROLES = ["paper", "ink", "primary", "tint", "accent", "line"] as const

/** The fixture with every photo a variant can show. Fictional paths. */
const PHOTOS: Record<string, string> = {
  heroCaption: "Fully insured",
  ctaImage: "/photos/two.jpg",
  ...Object.fromEntries(
    [1, 2, 3].flatMap((n) => [
      [`service${n}Image`, `/photos/service-${n}.jpg`],
      [`service${n}ImageAlt`, `A room after a ${FILLED[`service${n}Name`]}`],
    ])
  ),
}

const siteOf = (direction: (typeof DIRECTIONS)[number]) => {
  const palette = PALETTES.find((each) => each.id === direction.palettes[0])
  if (!palette) throw new Error(`${direction.id} names no palette`)
  return {
    ...FILLED,
    ...PHOTOS,
    direction: direction.id,
    font: direction.fonts,
    palette: ROLES.map((role) => `${role}:${palette[role]}`).join(" "),
  }
}

const sites: { id: string; built: Built; server: Server; origin: string }[] = []
let browser: Browser | undefined

beforeAll(async () => {
  // Four builds at a time: eight at once starve the machine.
  for (let at = 0; at < DIRECTIONS.length; at += 4) {
    const batch = DIRECTIONS.slice(at, at + 4)
    const built = await Promise.all(
      batch.map((direction) => build({ site: siteOf(direction) }))
    )
    for (const [i, each] of built.entries())
      sites.push({
        id: batch[i]?.id ?? "",
        built: each,
        ...(await serve(each.dist)),
      })
  }
  browser = await chromium.launch()
}, 600_000)

afterAll(async () => {
  await browser?.close()
  for (const site of sites) {
    site.server.close()
    clean(site.built)
  }
})

for (const direction of DIRECTIONS) {
  for (const width of [1440, 390]) {
    test(`${direction.id} at ${width} px has no accessibility violations`, async () => {
      const site = sites.find((each) => each.id === direction.id)
      if (!browser || !site)
        throw new Error("the browser or the build did not start")
      const page = await (
        await browser.newContext({ viewport: { width, height: 900 } })
      ).newPage()
      await page.goto(`${site.origin}/`)
      // The direction's own variants rendered, so one that silently fell
      // back cannot pass by being absent.
      for (const name of [
        `hero-${direction.hero}`,
        `services-${direction.services}`,
        `steps-${direction.steps}`,
        `faq-${direction.faq}`,
      ])
        expect(await page.locator(`.${name}`).count(), name).toBeGreaterThan(0)
      expect(await page.getAttribute("html", "data-direction")).toBe(
        direction.id
      )
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(
        results.violations.map((violation) => violation.id),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([])
    }, 120_000)
  }
}
