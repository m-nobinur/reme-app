import AxeBuilder from "@axe-core/playwright"
import { expect, type Page } from "@playwright/test"

/**
 * WCAG 2.2 AA, the bar this design system is held to. The best-practice rules
 * are left out on purpose: they flag the catalog harness itself, not the
 * primitives it renders.
 */
export const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

/** Loads one catalog entry alone, at a real viewport width, in one theme. */
export async function open(
  page: Page,
  entry: string,
  width = 1024,
  theme = "light"
) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/?entry=${encodeURIComponent(entry)}&theme=${theme}`)
  await expect(page.locator(`[data-entry="${entry}"]`)).toBeVisible()
  // Measured before Inter loads, the wider fallback font wraps rows that fit.
  await page.evaluate(() => document.fonts.ready)
}

/**
 * Waits for every finite animation to end, so contrast is read on settled
 * colours and not mid-fade. A transition cut short rejects `finished`, which
 * counts as settled; looping animations never end and are not waited on.
 */
export async function settled(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        .map((animation) => animation.finished.catch(() => null))
    )
  )
}

/** Scans the whole page once it has settled, and records each violation under `label` without stopping. */
export async function axe(page: Page, label: string) {
  await settled(page)
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect
    .soft(
      results.violations.map((violation) => `${label}: ${violation.id}`),
      JSON.stringify(results.violations, null, 2)
    )
    .toEqual([])
}
