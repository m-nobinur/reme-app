import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The question tray: a native radio group the keyboard walks, Enter for Next,
 * Escape to collapse, and the last question's Build my site. Each state in the
 * catalog entry is its own tray, so the first one is driven here.
 */

const tray = (page: import("@playwright/test").Page, n: number) =>
  page.locator('[data-slot="question-tray"]').nth(n)

test("arrow keys pick and Enter moves on", async ({ page }) => {
  await open(page, "QuestionTray")
  const first = tray(page, 0)
  await expect(first.getByRole("radiogroup")).toHaveCount(1)
  await expect(
    first.getByRole("button", { name: "Next", exact: true })
  ).toBeDisabled()
  await first.getByRole("radio").first().focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowRight")
  await expect(first.getByRole("radio").nth(1)).toBeChecked()
  await page.keyboard.press("Enter")
  await expect(first.getByText("2 of 4")).toBeVisible()
  await expect(first.getByRole("radiogroup")).toHaveAccessibleName(
    "Which lettering do you prefer?"
  )
})

test("Escape collapses to one row and the row opens it again", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const first = tray(page, 0)
  await first.getByRole("radio").first().focus()
  await page.keyboard.press("Escape")
  await expect(first.getByRole("radiogroup")).toHaveCount(0)
  await first.getByRole("button", { expanded: false }).click()
  await expect(first.getByRole("radiogroup")).toHaveCount(1)
})

test("the last question reads Build my site", async ({ page }) => {
  await open(page, "QuestionTray")
  await expect(
    tray(page, 4).getByRole("button", { name: "Build my site" })
  ).toBeEnabled()
})

test("the tray has no accessibility violations, in both themes and on a phone", async ({
  page,
}) => {
  for (const [width, theme] of [
    [1024, "light"],
    [1024, "dark"],
    [360, "light"],
  ] as const) {
    await open(page, "QuestionTray", width, theme)
    await axe(page, `QuestionTray ${width} ${theme}`)
  }
})
