import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * Choose your domain, in the assistant's message: up to six names, each row
 * its name, a sub line with its price and provider, the recommended one's
 * badge inside its own row, and Choose. A chosen row offers Buy from each
 * provider. In both themes and at a phone's width.
 */

for (const theme of ["light", "dark"]) {
  for (const width of [1024, 390]) {
    test(`the domain list, ${theme} at ${width} px`, async ({ page }) => {
      await open(page, "FindDomain", width, theme)
      const picker = page.locator('[data-slot="domain-picker"]').first()
      await expect(
        picker.getByRole("heading", { name: "Choose your domain" })
      ).toBeVisible()
      const list = picker.getByRole("list", { name: "Domains" })
      const rows = list.getByRole("listitem")
      const count = await rows.count()
      expect(count).toBeGreaterThan(1)
      expect(count).toBeLessThanOrEqual(6)
      // The recommended name is first, its badge inside its row.
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
        await expect(rows.nth(at)).toContainText("£")
      }
      // Choosing gives the row its providers, and nothing spills sideways.
      await rows.first().getByRole("button").click()
      await expect(
        rows.first().getByRole("link", { name: /Buy from Cloudflare/ })
      ).toBeVisible()
      await expect(
        rows.first().getByRole("link", { name: /Buy from GoDaddy/ })
      ).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        )
      ).toBe(false)
      // A skipped list asked for again gives way to the fresh one.
      await expect(
        page.getByText("You skipped choosing, so there's a fresh list below.")
      ).toBeVisible()
      await axe(page, `FindDomain ${theme} ${width}`)
    })
  }
}
