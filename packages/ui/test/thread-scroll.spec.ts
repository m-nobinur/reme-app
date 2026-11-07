import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * Sending moves the owner's message up and the reply fills in under it. The
 * view never scrolls back up on its own: not when the reply lands, not while
 * it streams, and not when the turn ends. A scroll back up showed the previous
 * reply again, which read as the thread jumping to the top and returning.
 */

/**
 * Every scrollTop the viewport shows, each frame, from now on. Read in a
 * ResizeObserver made after the thread's, so after its own callback and just
 * before paint: a read in requestAnimationFrame forces layout between a
 * streamed commit and that callback, and caught a clamp the thread undoes
 * before the frame is drawn. A marker resized each frame makes it run.
 */
async function recordScroll(page: Page, entry: string) {
  await page.locator(`[data-entry="${entry}"]`).evaluate((root) => {
    const viewport = root.querySelector<HTMLElement>(
      '[data-slot="aui_thread-viewport"]'
    )
    if (!viewport) throw new Error("no viewport")
    const seen: number[] = []
    Object.assign(window, { seen })
    const marker = document.createElement("div")
    marker.style.cssText = "position:fixed;top:0;left:0;height:1px"
    document.body.append(marker)
    new ResizeObserver(() => {
      if (seen.at(-1) !== viewport.scrollTop) seen.push(viewport.scrollTop)
    }).observe(marker)
    let frame = 0
    const tick = () => {
      marker.style.width = `${(frame++ % 2) + 1}px`
      requestAnimationFrame(tick)
    }
    tick()
  })
}

const recorded = (page: Page) =>
  page.evaluate(() => (window as unknown as { seen: number[] }).seen)

for (const entry of ["ThreadSend", "ThreadSendStreamed"]) {
  test(`${entry}: the view never scrolls back up after a send`, async ({
    page,
  }) => {
    await open(page, entry)
    const root = page.locator(`[data-entry="${entry}"]`)
    // Before the send the conversation fits, as every catalog thread must.
    await expect(
      root.locator(".aui-thread-scroll-to-bottom:visible")
    ).toHaveCount(0)
    const input = root.getByLabel("Message input")
    await input.fill("07700 900123")
    await recordScroll(page, entry)
    await input.press("Enter")
    // The turn is over once the next question's card is in.
    await expect(
      root.getByRole("textbox", { name: "Email address" })
    ).toBeVisible({
      timeout: 10_000,
    })
    // The end of a turn settles over a few frames; watch past it.
    await page.waitForTimeout(1500)

    const seen = await recorded(page)
    // It did move: the sent message went up.
    expect(Math.max(...seen)).toBeGreaterThan(seen[0] ?? 0)
    const drops = seen.flatMap((top, index) =>
      index > 0 && top < (seen[index - 1] ?? 0) - 1
        ? [`${seen[index - 1]} -> ${top}`]
        : []
    )
    expect(drops, `scrollTop over the turn: ${seen.join(", ")}`).toEqual([])
  })
}

// Chrome counted the composer as moved when the next question's tray docked
// above it (CLS 0.018 at 1024, 0.025 at 390), though it never moved on screen.
for (const width of [1024, 390]) {
  test(`a tray docking above the composer shifts nothing at ${width} px`, async ({
    page,
  }) => {
    const entry = "ThreadSendStreamed"
    await open(page, entry, width)
    const root = page.locator(`[data-entry="${entry}"]`)
    const input = root.getByLabel("Message input")
    await input.fill("07700 900123")
    await page.evaluate(() => {
      const shifts: number[] = []
      ;(window as unknown as { shifts: number[] }).shifts = shifts
      new PerformanceObserver((list) => {
        for (const shift of list.getEntries() as unknown as {
          value: number
          hadRecentInput: boolean
        }[]) {
          // Under 0.001 is sub-pixel rounding, not a move anyone sees.
          if (!shift.hadRecentInput && shift.value >= 0.001)
            shifts.push(shift.value)
        }
      }).observe({ type: "layout-shift" })
    })
    await input.press("Enter")
    await expect(
      root.getByRole("textbox", { name: "Email address" })
    ).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1000)
    expect(
      await page.evaluate(
        () => (window as unknown as { shifts: number[] }).shifts
      )
    ).toEqual([])
  })
}

// Scrolled up to read, a tray that grows between pages leaves the view where
// it is, as chat apps do. At the bottom it follows (measured on a long thread).
test("a tray growing leaves a reader who scrolled up where they are", async ({
  page,
}) => {
  const entry = "ThreadSendStreamed"
  await open(page, entry, 390)
  const root = page.locator(`[data-entry="${entry}"]`)
  const viewport = root.locator('[data-slot="aui_thread-viewport"]')
  // A box shorter than the conversation, so there is somewhere to read.
  await viewport.evaluate((box) => {
    box.style.height = "220px"
    box.style.flex = "none"
  })
  await page.waitForTimeout(500)
  await viewport.hover()
  await page.mouse.wheel(0, -2000)
  await page.waitForTimeout(500)
  const top = await viewport.evaluate((box) => box.scrollTop)
  expect(top, "the reader is scrolled up").toBeLessThan(
    await viewport.evaluate((box) => box.scrollHeight - box.clientHeight)
  )
  await root.locator(".aui-thread-viewport-footer").evaluate((footer) => {
    const grown = document.createElement("div")
    grown.style.height = "160px"
    footer.append(grown)
  })
  await page.waitForTimeout(800)
  expect(await viewport.evaluate((box) => box.scrollTop)).toBe(top)
})

// With the list on screen and the reply below it, the button sat over the
// sixth row's price line until the reader scrolled on.
for (const theme of ["light", "dark"]) {
  for (const width of [1024, 390]) {
    test(`Scroll to bottom keeps clear of a picker row's text, ${theme} at ${width} px`, async ({
      page,
    }) => {
      const entry = "FindDomain"
      await open(page, entry, width, theme)
      const root = page.locator(`[data-entry="${entry}"]`).first()
      await root
        .locator(".aui-thread-root")
        .first()
        .evaluate((thread) => {
          ;(thread as HTMLElement).style.height = "24rem"
        })
      const viewport = root.locator('[data-slot="aui_thread-viewport"]').first()
      const subs = root.locator('[data-slot="domain-picker"] [id$="-sub"]')
      const count = await subs.count()
      expect(count).toBeGreaterThan(1)
      // Only the first of the entry's three threads is made short.
      const button = root
        .locator(".aui-thread-root")
        .first()
        .locator(".aui-thread-scroll-to-bottom:visible")
      const text = new Set<string>()
      // Each row in turn parked just above the composer, where the button floats.
      for (let at = 0; at < count; at++) {
        await subs.nth(at).scrollIntoViewIfNeeded()
        await viewport.evaluate((box) => {
          box.scrollTop -= 40
        })
        await expect(button).toBeVisible()
        const shown = await button.boundingBox()
        const line = await subs.nth(at).boundingBox()
        expect(shown && line).toBeTruthy()
        if (shown && line) {
          expect(
            shown.x >= line.x + line.width || shown.x + shown.width <= line.x,
            `row ${at}: the button at x ${shown.x} to ${shown.x + shown.width} over text at ${line.x} to ${line.x + line.width}`
          ).toBe(true)
        }
        text.add(await subs.nth(at).innerText())
      }
      expect(text.size).toBeGreaterThan(1)
    })
  }
}
