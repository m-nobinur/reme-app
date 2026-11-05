import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * Choose your web address: up to six names in one list, each row saying the
 * name is free and its price, and the recommended one's badge inside its
 * own row. In both themes and at a phone's width.
 */

for (const theme of ["light", "dark"]) {
  for (const width of [1024, 390]) {
    test(`the web address list, ${theme} at ${width} px`, async ({ page }) => {
      await open(page, "FindDomain", width, theme)
      const list = page.getByRole("radiogroup", { name: "Web address" }).first()
      const rows = list.locator("label")
      const count = await rows.count()
      expect(count).toBeGreaterThan(1)
      expect(count).toBeLessThanOrEqual(6)
      // The recommended name is first and picked, its badge inside its row.
      await expect(list.getByRole("radio").first()).toBeChecked()
      const first = await rows.first().boundingBox()
      const badge = await rows
        .first()
        .getByText("Recommended", { exact: true })
        .boundingBox()
      expect(first && badge).toBeTruthy()
      if (first && badge) {
        expect(badge.y).toBeGreaterThanOrEqual(first.y)
        expect(badge.x + badge.width).toBeLessThanOrEqual(first.x + first.width)
        expect(badge.y + badge.height).toBeLessThanOrEqual(
          first.y + first.height
        )
      }
      await expect(list.getByText("Recommended", { exact: true })).toHaveCount(
        1
      )
      for (let at = 0; at < count; at++) {
        await expect(rows.nth(at)).toContainText("Available")
      }
      // A name reads whole: nothing in a row is cut but the name itself.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        )
      ).toBe(false)
      // Arrow keys move the pick, as one radio group.
      await list.getByRole("radio").first().focus()
      await page.keyboard.press("ArrowDown")
      await expect(list.getByRole("radio").nth(1)).toBeChecked()
      await axe(page, `FindDomain ${theme} ${width}`)
    })
  }
}
