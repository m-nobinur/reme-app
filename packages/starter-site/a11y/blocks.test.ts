/**
 * axe at WCAG 2.2 AA over a home page document that holds one block of each
 * type and a custom section, in a light direction and the dark one, at
 * desktop and phone width. Run it with
 * `pnpm --filter @workspace/starter-site exec vitest run a11y/blocks.test.ts`.
 */

import type { Server } from "node:http"
import AxeBuilder from "@axe-core/playwright"
import { type Browser, chromium } from "@playwright/test"
import { BLOCK_TYPES } from "@workspace/contracts"
import { afterAll, beforeAll, expect, test } from "vitest"
import { everyBlockFiles } from "../test/blocks"
import { build, serve } from "../test/build"
import { FILLED } from "../test/fixture"

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
const DIRECTIONS = ["fresh_modern", "after_dark"] as const

const sites: { id: string; server: Server; origin: string }[] = []
let browser: Browser | undefined

beforeAll(async () => {
  const files = await everyBlockFiles()
  for (const direction of DIRECTIONS) {
    const built = await build({ site: { ...FILLED, direction }, files })
    sites.push({ id: direction, ...(await serve(built.dist)) })
  }
  browser = await chromium.launch()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  for (const site of sites) site.server.close()
})

for (const direction of DIRECTIONS) {
  for (const width of [1440, 390]) {
    test(`every block in ${direction} at ${width} px has no accessibility violations`, async () => {
      const site = sites.find((each) => each.id === direction)
      if (!browser || !site)
        throw new Error("the browser or the build did not start")
      const page = await (
        await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        })
      ).newPage()
      await page.goto(`${site.origin}/`)
      // Each block rendered, so one that silently dropped cannot pass by being absent.
      for (const type of BLOCK_TYPES)
        expect(
          await page.locator(`.block-${type}`).count(),
          type
        ).toBeGreaterThan(0)
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(
        results.violations.map((violation) => violation.id),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([])
    }, 120_000)
  }
}
