/**
 * What the first screen looks like, measured in a browser: a hero cropped to
 * its shape even when the upload is a tall portrait, a page hero that fills
 * both halves, a phone header that keeps the name on one line, and an
 * eyebrow dot in the colour of its text. Run it with
 * `pnpm --filter @workspace/starter-site exec vitest run a11y/layout.test.ts`.
 */

import type { Server } from "node:http"
import { type Browser, chromium, type Page } from "@playwright/test"
import sharp from "sharp"
import { afterAll, beforeAll, expect, test } from "vitest"
import { type Built, build, clean, serve } from "../test/build"
import { FILLED } from "../test/fixture"

let built: Built | undefined
let server: Server | undefined
let origin = ""
let browser: Browser | undefined

beforeAll(async () => {
  const portrait = await sharp({
    create: {
      width: 1024,
      height: 1536,
      channels: 3,
      background: { r: 190, g: 170, b: 140 },
    },
  })
    .jpeg()
    .toBuffer()
  built = await build({
    site: {
      ...FILLED,
      businessName: "Hollowick Sparkle Crew",
      logo: "",
      quoteHeading: "Get a quote for your handover clean",
      quoteIntro:
        "Tell us about the property and the job. Landlords, letting agents and builders in Hollowick use this form to ask for a quote.",
    },
    files: { "src/assets/uploads/hero.jpg": new Uint8Array(portrait) },
  })
  ;({ server, origin } = await serve(built.dist))
  browser = await chromium.launch()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  clean(built)
})

const open = async (width: number, height: number, path: string) => {
  if (!browser) throw new Error("the browser did not start")
  const page = await (
    await browser.newContext({ viewport: { width, height } })
  ).newPage()
  await page.goto(`${origin}${path}`)
  return page
}
const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox()
  if (!found) throw new Error(`${selector} is not on the page`)
  return found
}

test("a portrait upload is cropped, and the hero fits the first screen at 1440", async () => {
  const page = await open(1440, 900, "/")
  const image = await box(page, ".hero-image")
  // 5:4, not the file's own 2:3 height, which stood 1,500 px tall.
  expect(image.height / image.width).toBeCloseTo(0.8, 1)
  expect(image.y + image.height).toBeLessThan(900)
  // No empty block above the copy: the eyebrow starts beside the photo.
  const eyebrow = await box(page, ".hero .eyebrow")
  expect(Math.abs(eyebrow.y - image.y)).toBeLessThan(80)
})

test("the quote page's hero fills both halves at 1440", async () => {
  const page = await open(1440, 900, "/quote/")
  const heading = await box(page, ".hero h1")
  const lede = await box(page, ".hero .lede")
  expect(lede.x).toBeGreaterThan(720)
  expect(heading.width).toBeGreaterThan(500)
})

test("the phone header keeps the name on one line and the action in the menu", async () => {
  const page = await open(390, 844, "/")
  const name = await box(page, ".site-name")
  // One line of the wordmark, not two.
  expect(name.height).toBeLessThan(48)
  expect(await page.locator(".header-action").isVisible()).toBe(false)
  await page.locator(".menu-toggle").click()
  expect(await page.locator(".menu-action a").isVisible()).toBe(true)
  // At 480 px and up the button is back and the menu does not repeat it.
  const wide = await open(800, 900, "/")
  expect(await wide.locator(".header-action").isVisible()).toBe(true)
  expect(await wide.locator(".menu-action").isVisible()).toBe(false)
})

test("the eyebrow dot is the colour of the eyebrow", async () => {
  const page = await open(1440, 900, "/")
  const [dot, text] = await page.evaluate(() => {
    const el = document.querySelector(".hero .eyebrow")
    if (!el) return ["", ""]
    return [
      getComputedStyle(el, "::before").backgroundColor,
      getComputedStyle(el).color,
    ]
  })
  expect(dot).toBe(text)
})

test("five service cards fill rows of 3 and 2, the last row centred", async () => {
  const five = await build({
    site: {
      ...FILLED,
      direction: "calm_daylight",
      ...Object.fromEntries(
        [1, 2, 3, 4, 5].flatMap((n) => [
          [`service${n}Name`, `Service ${n}`],
          [`service${n}Body`, `What service ${n} covers.`],
          [`service${n}Image`, `/photos/service-${n}.jpg`],
          [`service${n}ImageAlt`, `Service ${n} at work`],
        ])
      ),
    },
  })
  const { server: other, origin: base } = await serve(five.dist)
  try {
    if (!browser) throw new Error("the browser did not start")
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage()
    await page.goto(`${base}/`)
    const cards = await page.locator(".card-grid > .card").evaluateAll((els) =>
      els.map((el) => {
        const { x, y, width } = el.getBoundingClientRect()
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width) }
      })
    )
    expect(cards).toHaveLength(5)
    const rows = [...new Set(cards.map((c) => c.y))]
    expect(rows).toHaveLength(2)
    expect(cards.filter((c) => c.y === rows[0])).toHaveLength(3)
    expect(new Set(cards.map((c) => c.width)).size).toBe(1)
    // The two on the last row are centred under the three.
    const [first, , last, fourth, fifth] = cards
    if (!(first && last && fourth && fifth)) throw new Error("missing cards")
    const left = fourth.x - first.x
    const right = last.x + last.width - (fifth.x + fifth.width)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  } finally {
    other.close()
    clean(five)
  }
}, 120_000)

// bright_local sets its accent clause on one line for the stroke beneath it; a
// long clause pushed the whole column wider than a phone.
test("a long accent clause in the areas heading stays inside a 390 px phone", async () => {
  const wide = await build({
    site: {
      ...FILLED,
      direction: "bright_local",
      serviceAreaHeading: "Gardens across *Bristol, Bath and Clevedon*",
      areaTowns: "Bristol\nBath\nClevedon",
      areaBody: "We work in Bristol, Bath and Clevedon.",
    },
  })
  const { server: other, origin: base } = await serve(wide.dist)
  try {
    if (!browser) throw new Error("the browser did not start")
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage()
    await page.goto(`${base}/`)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(390)
    const right = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll(".area-section *")].map(
          (el) => el.getBoundingClientRect().right
        )
      )
    )
    expect(right).toBeLessThanOrEqual(390)
  } finally {
    other.close()
    clean(wide)
  }
}, 120_000)
