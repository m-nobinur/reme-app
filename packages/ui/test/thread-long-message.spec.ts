import { expect, type Locator, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * An owner's message of more than eight lines folds to six behind Show more.
 * The entry holds one of twelve lines, one of exactly eight and a short one.
 */

const roots = (page: Page) =>
  page.locator('[data-slot="aui_user-message-root"]')
const toggle = (root: Locator) =>
  root.getByRole("button", { name: /^Show (more|less)$/ })
const text = (root: Locator) =>
  root.locator('[data-slot="aui_user-message-text"]')

/** The text box's height in lines, as the reader sees it. */
const lines = (clip: Locator) =>
  clip.evaluate((el) => {
    const line = Number.parseFloat(getComputedStyle(el).lineHeight)
    return { shown: el.clientHeight / line, whole: el.scrollHeight / line }
  })

/** The root's height against the viewport's top-anchor clamp, in px. */
const CLAMP = 20 * 16

for (const [what, width] of [
  ["desktop", 1024],
  ["phone", 390],
] as const) {
  test(`a long message folds to six lines and opens and closes (${what})`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await open(page, "ThreadLongMessage", width)
    const [long, eight, short] = [0, 1, 2].map((i) => roots(page).nth(i))
    if (!long || !eight || !short) throw new Error("missing message")

    const button = toggle(long)
    await expect(button).toHaveText("Show more")
    await expect(button).toHaveAttribute("aria-expanded", "false")
    const folded = await lines(text(long))
    expect(folded.shown).toBeCloseTo(6, 1)
    expect(folded.whole).toBeGreaterThan(8)
    // The full text is still in the page, for a copy or a screen reader.
    await expect(text(long)).toContainText("two hour minimum")
    expect((await long.boundingBox())?.height).toBeLessThan(CLAMP)

    await button.click()
    await expect(button).toHaveText("Show less")
    await expect(button).toHaveAttribute("aria-expanded", "true")
    expect((await lines(text(long))).shown).toBeCloseTo(folded.whole, 1)

    await button.click()
    await expect(button).toHaveText("Show more")
    expect((await lines(text(long))).shown).toBeCloseTo(6, 1)

    // Eight lines is as long as a message stays whole, and sits under the clamp.
    await expect(toggle(eight)).toHaveCount(0)
    await expect(toggle(short)).toHaveCount(0)
    expect((await lines(text(eight))).shown).toBeCloseTo(8, 1)
    expect((await eight.boundingBox())?.height).toBeLessThan(CLAMP)
    await expect(
      page.locator(".aui-thread-scroll-to-bottom:visible")
    ).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test("Show more is reached and worked from the keyboard, with a focus ring", async ({
  page,
}) => {
  await open(page, "ThreadLongMessage")
  const button = toggle(roots(page).first())
  await button.focus()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(button).toBeFocused()
  await expect(button).not.toHaveCSS("box-shadow", "none")
  await page.keyboard.press("Enter")
  await expect(button).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Space")
  await expect(button).toHaveAttribute("aria-expanded", "false")
})

test("a design answer never folds", async ({ page }) => {
  await open(page, "DesignReply")
  await expect(roots(page)).toHaveCount(1)
  await expect(
    page.getByRole("button", { name: /^Show (more|less)$/ })
  ).toHaveCount(0)
})

for (const theme of ["light", "dark"] as const) {
  test(`a folded message has no accessibility violations (${theme})`, async ({
    page,
  }) => {
    await open(page, "ThreadLongMessage", 1024, theme)
    await axe(page, `ThreadLongMessage ${theme}`)
  })
}
