import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * Sending moves the owner's message up and the reply fills in under it. The
 * view never scrolls back up on its own: not when the reply lands, not while
 * it streams, and not when the turn ends. A scroll back up showed the previous
 * reply again, which read as the thread jumping to the top and returning.
 */

/** Every scrollTop the viewport takes, each animation frame, from now on. */
async function recordScroll(page: Page, entry: string) {
  await page.locator(`[data-entry="${entry}"]`).evaluate((root) => {
    const viewport = root.querySelector<HTMLElement>(
      '[data-slot="aui_thread-viewport"]'
    )
    if (!viewport) throw new Error("no viewport")
    const seen: number[] = []
    Object.assign(window, { seen })
    const tick = () => {
      if (seen.at(-1) !== viewport.scrollTop) seen.push(viewport.scrollTop)
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
