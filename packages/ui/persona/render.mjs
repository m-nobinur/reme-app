/**
 * Renders Reme from scene.html into the frames Persona uses: the full
 * figure and the face, each with eyes open and shut.
 *
 *   node packages/ui/persona/render.mjs
 *
 * three.js comes from jsDelivr inside the headless page, so nothing here is a
 * dependency of the app.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

const scene = new URL("./scene.html", import.meta.url)
const assets = fileURLToPath(new URL("../src/assets/persona/", import.meta.url))
const SIZES = { full: 768, face: 256 }

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
})
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
page.on("pageerror", (error) => console.error(error.message))
await page.goto(scene.href)
await page.waitForFunction(() => window.ready, null, { timeout: 60_000 })
for (const [framing, size] of Object.entries(SIZES)) {
  for (const pose of ["open", "blink"]) {
    const url = await page.evaluate(
      ([p, f, s]) => window.pose(p, f, s),
      [pose, framing, size]
    )
    const file = `${assets}reme-${framing}-${pose}.webp`
    writeFileSync(file, Buffer.from(url.split(",")[1], "base64"))
    console.log(file)
  }
}
await browser.close()
