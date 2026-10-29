/**
 * Why the sandbox's axe scan and screenshots emulate reduced motion
 * (infra/sandbox/astro/axe.mjs, apps/orchestrator/sandbox/shots.mjs). The
 * entrance reveal holds a block at zero opacity until it enters the viewport
 * and then fades it up, so a block at the fold is below full opacity and axe
 * reads its text as low contrast (a false color-contrast on a service link,
 * 2026-10-14). Under `prefers-reduced-motion: reduce`, and with no script,
 * the reveal never runs and every block is visible.
 *
 * Run with `pnpm --filter @workspace/starter-site test:a11y`.
 */

import type { Server } from "node:http"
import { type Browser, chromium } from "@playwright/test"
import { afterAll, beforeAll, expect, test } from "vitest"
import { type Built, build, serve } from "../test/build"
import { FILLED } from "../test/fixture"

const REVEALED =
  ".band :is(.section-head, .card, .service-rows li, .value-list li, .step-list li, .testimonials figure, .gallery-grid li, .gallery-single)"
const HEIGHT = 900

let built: Built | undefined
let server: Server | undefined
let origin = ""
let browser: Browser | undefined

beforeAll(async () => {
  built = await build({ site: FILLED })
  ;({ server, origin } = await serve(built.dist))
  browser = await chromium.launch()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
})

/**
 * The opacity of a revealed block below the fold, with the page scrolled
 * until a tenth of it is inside the viewport: where a scan finds the blocks
 * at the fold of a page taller than the screen.
 */
async function entering(reducedMotion: "reduce" | "no-preference") {
  if (!browser) throw new Error("the browser did not start")
  const context = await browser.newContext({
    viewport: { width: 1440, height: HEIGHT },
    reducedMotion,
  })
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/services/`)
    const block = page.locator(REVEALED).nth(3)
    const { top, height } = await block.evaluate((el) =>
      el.getBoundingClientRect().toJSON()
    )
    // A tenth of the block in: inside the first 35% the reveal runs over.
    await page.evaluate(
      (by) => window.scrollBy(0, by),
      top - (HEIGHT - height / 10)
    )
    // A scroll-driven animation advances on the next frames.
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done))
        )
    )
    return await block.evaluate((el) => Number(getComputedStyle(el).opacity))
  } finally {
    await context.close()
  }
}

test("a block entering the viewport is below full opacity unless motion is reduced", async () => {
  expect(await entering("no-preference")).toBeLessThan(1)
}, 60_000)

test("with reduced motion a block entering the viewport is at full opacity", async () => {
  expect(await entering("reduce")).toBe(1)
}, 60_000)

/** Every revealed block's opacity, on a page opened with these options. */
async function opacities(
  options: {
    reducedMotion: "reduce" | "no-preference"
    javaScriptEnabled?: boolean
  },
  scrolled = false
) {
  if (!browser) throw new Error("the browser did not start")
  const context = await browser.newContext({
    viewport: { width: 1440, height: HEIGHT },
    ...options,
  })
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/services/`)
    if (scrolled) {
      // Down the page a screen at a time, so each block enters and plays.
      const height = await page.evaluate(() => document.body.scrollHeight)
      for (let y = 0; y < height; y += HEIGHT / 2) {
        await page.evaluate((to) => window.scrollTo(0, to), y)
        await page.waitForTimeout(120)
      }
      // The longest reveal: 560 ms after a 210 ms stagger.
      await page.waitForTimeout(900)
    }
    return {
      marked: await page.evaluate(() =>
        document.documentElement.hasAttribute("data-reveal")
      ),
      values: await page
        .locator(REVEALED)
        .evaluateAll((all) =>
          all.map((el) => Number(getComputedStyle(el).opacity))
        ),
    }
  } finally {
    await context.close()
  }
}

test("every block that has entered ends at full opacity", async () => {
  const { marked, values } = await opacities(
    { reducedMotion: "no-preference" },
    true
  )
  expect(marked).toBe(true)
  expect(values.length).toBeGreaterThan(3)
  expect(values.every((value) => value === 1)).toBe(true)
}, 60_000)

test("with no script or with reduced motion nothing is hidden, unscrolled", async () => {
  for (const options of [
    { reducedMotion: "no-preference" as const, javaScriptEnabled: false },
    { reducedMotion: "reduce" as const },
  ]) {
    const { marked, values } = await opacities(options)
    expect(marked, JSON.stringify(options)).toBe(false)
    expect(
      values.every((value) => value === 1),
      JSON.stringify(options)
    ).toBe(true)
  }
}, 60_000)
