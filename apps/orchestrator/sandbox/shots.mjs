// The preview's screenshots, run in the sandbox by takeScreenshots
// (apps/orchestrator/src/shots.ts): `node /tmp/shots.mjs <url> <outDir> <cropMax>`.
//
// Per width: the whole home page as `home-<w>.png` (the review card's image),
// and viewport-height pieces of it, top to bottom, as `crop-<w>-<n>.png` from
// 1, at most `cropMax` of them (the design critic's pictures: a model refuses
// an image over 8000 px and scales a tall one to about 1568 px on its long
// edge, so a full page reaches it unreadable).
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export const WIDTHS = [390, 768, 1440]
export const HEIGHT = 900

// Runs in the page. A full-page capture never scrolls, so a lazy image below
// the fold stays an empty box. Here the capture alone makes every image eager
// and scrolls the page through once (which also fires scroll-driven reveals),
// then waits for each image to decode; the site keeps its `loading="lazy"`.
export async function inPage() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (const img of document.images) img.loading = "eager"
  const step = Math.max(window.innerHeight, 1)
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
    window.scrollTo(0, y)
    await wait(50)
  }
  await Promise.race([
    Promise.all(
      [...document.images].map((img) => img.decode().catch(() => undefined))
    ),
    wait(5000),
  ])
  window.scrollTo(0, 0)
}

export async function shoot(browser, url, dir, cropMax) {
  let failed = false
  for (const width of WIDTHS) {
    try {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
      })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: "load" })
      await page.evaluate(inPage)
      await page.screenshot({
        path: `${dir}/home-${width}.png`,
        fullPage: true,
      })
      const total = await page.evaluate(
        () => document.documentElement.scrollHeight
      )
      const parts = Math.min(cropMax, Math.ceil(total / HEIGHT))
      for (let n = 0; n < parts; n++) {
        const y = n * HEIGHT
        await page.screenshot({
          path: `${dir}/crop-${width}-${n + 1}.png`,
          fullPage: true,
          clip: { x: 0, y, width, height: Math.min(HEIGHT, total - y) },
        })
      }
      await context.close()
    } catch (error) {
      failed = true
      console.error(`${width}: ${error}`)
    }
  }
  return !failed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, dir, cropMax] = process.argv.slice(2)
  // The image installs Playwright globally, which an ES import does not search.
  const { chromium } = createRequire("/usr/local/lib/node_modules/")(
    "playwright"
  )
  const browser = await chromium.launch()
  try {
    process.exitCode = (await shoot(browser, url, dir, Number(cropMax))) ? 0 : 1
  } finally {
    await browser.close()
  }
}
