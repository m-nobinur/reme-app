import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The status line at phone width in both themes: its working, changing,
 * finished, failed and waiting rows pass WCAG, and a change of words
 * cross-fades, the old words leaving the screen within the fade. Set
 * `STATUS_FRAMES` to a folder to keep a frame strip of the change.
 */

const ENTRIES = [
  "StatusLine changing words",
  "StatusLine ended",
  "ToolStatus",
] as const
const FRAMES = process.env.STATUS_FRAMES

for (const theme of ["light", "dark"] as const) {
  test(`status rows pass WCAG at 390 px in ${theme}`, async ({ page }) => {
    for (const entry of ENTRIES) {
      await open(page, entry, 390, theme)
      await axe(page, `${entry} ${theme}`)
      if (FRAMES) {
        await page
          .locator(`[data-entry="${entry}"]`)
          .screenshot({ path: `${FRAMES}/${entry}-${theme}.png` })
      }
    }
  })

  test(`changing words cross-fade in ${theme}`, async ({ page }) => {
    const entry = "StatusLine changing words"
    // Timers wait on the test, so the old words stay until it moves time on.
    await page.clock.install()
    await open(page, entry, 390, theme)
    const root = page.locator(`[data-entry="${entry}"]`)
    const line = root.locator('[data-slot="status-line"]')
    const words = line.locator('[data-slot="status-line-text"]')
    const outgoing = line.locator('[data-slot="status-line-outgoing"]')
    await expect(words).toHaveText("Reme is reading your message")
    // Past the two seconds a working line keeps its words, then held still.
    const now = await page.evaluate(() => Date.now())
    await page.clock.pauseAt(now + 2500)
    await root.getByRole("button", { name: "Next words" }).click()
    await expect(words).toHaveText("Working out the quietest morning")
    await expect(outgoing).toHaveText("Reme is reading your message")
    const shots: Buffer[] = []
    for (const at of [0, 30, 60, 90, 120, 150]) {
      // Each fade held at `at` ms, the shimmer with them.
      await page.evaluate((ms) => {
        for (const animation of document.getAnimations()) {
          animation.pause()
          animation.currentTime = ms
        }
      }, at)
      const opacity = (el: typeof words) =>
        el.locator("xpath=.").evaluate((node) => {
          const inner = node.firstElementChild ?? node
          return Number(getComputedStyle(inner).opacity)
        })
      if (at === 60) {
        expect(await opacity(words)).toBeGreaterThan(0)
        expect(await opacity(words)).toBeLessThan(1)
        expect(
          await outgoing.evaluate((node) =>
            Number(getComputedStyle(node).opacity)
          )
        ).toBeLessThan(1)
      }
      if (FRAMES) shots.push(await line.screenshot())
    }
    await page.clock.runFor(200)
    await expect(outgoing).toHaveCount(0)
    if (FRAMES) {
      const strip = shots
        .map(
          (png) => `<img src="data:image/png;base64,${png.toString("base64")}">`
        )
        .join("")
      await page.setContent(
        `<body style="margin:0;display:flex;flex-direction:column;width:max-content">${strip}</body>`
      )
      await page.screenshot({
        fullPage: true,
        path: `${FRAMES}/changing-words-strip-${theme}.png`,
      })
    }
  })
}
