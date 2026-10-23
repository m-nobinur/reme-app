import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * The floating panel never covers the conversation on a desktop: from `lg`
 * the thread's column keeps clear of it. On a phone the panel is a line
 * under the top bar and nothing scrolls sideways.
 */

const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const { left, right } = node.getBoundingClientRect()
      return { left, right }
    })

for (const width of [1024, 1280, 1360, 1440, 1920]) {
  test(`at ${width} wide the panel and the conversation do not overlap`, async ({
    page,
  }) => {
    await open(page, "Conversation", width)
    const panel = await rect(page, "#workspace-panel")
    const composer = await rect(page, '[data-slot="aui_composer-shell"]')
    expect(composer.right).toBeLessThanOrEqual(panel.left)
  })
}

test("on a phone nothing scrolls sideways", async ({ page }) => {
  await open(page, "Conversation", 390)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
  ).toBe(false)
  const composer = await rect(page, '[data-slot="aui_composer-shell"]')
  expect(composer.right).toBeLessThanOrEqual(390)
})

for (const width of [390, 1440]) {
  test(`at ${width} wide the floating pill keeps no room and fits`, async ({
    page,
  }) => {
    await open(page, "WorkspaceShell floating", width)
    const main = await rect(page, "#main")
    const content = await rect(page, '[data-slot="workspace-page"]')
    // Centred in the page: as much space at the right as at the left.
    expect(
      Math.abs(main.right - content.right - (content.left - main.left))
    ).toBeLessThanOrEqual(1)
    const pill = await rect(page, "#workspace-panel")
    expect(pill.right).toBeLessThanOrEqual(width)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      )
    ).toBe(false)
  })
}
