import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The question tray: a native radio group the keyboard walks, Enter for Next,
 * Escape to collapse, and the last question's Build my site. Each state in the
 * catalog entry is its own tray under its own title.
 */

const tray = (page: import("@playwright/test").Page, n: number) =>
  page.locator('[data-slot="question-tray"]').nth(n)

/** The tray of the catalog state titled `title`. */
const state = (page: import("@playwright/test").Page, title: string) =>
  page
    .locator("section")
    .filter({ has: page.locator(`:scope > h3:text-is("${title}")`) })
    .locator('[data-slot="question-tray"]')

test("arrow keys pick and Enter moves on", async ({ page }) => {
  await open(page, "QuestionTray")
  const first = state(page, "Palette, nothing picked")
  await expect(first.getByRole("radiogroup")).toHaveCount(1)
  await expect(
    first.getByRole("button", { name: "Next", exact: true })
  ).toBeDisabled()
  await first.getByRole("radio").first().focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowRight")
  await expect(first.getByRole("radio").nth(1)).toBeChecked()
  await page.keyboard.press("Enter")
  await expect(first.getByText("3 of 6", { exact: true })).toBeVisible()
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

test("a card of many ticks several with Space, in order, and none is unanswered", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const pages = state(page, "Pages, several ticked")
  const group = pages.getByRole("group", {
    name: "Which pages should the site have, besides Home and Request a quote?",
  })
  await expect(group).toHaveCount(1)
  // Said under the question and read with the tray; a card of one has no such line.
  await expect(pages).toHaveAccessibleDescription("Pick any that fit")
  await expect(pages.getByText("Pick any that fit")).toBeVisible()
  await expect(tray(page, 0).getByText("Pick any that fit")).toHaveCount(0)
  await expect(pages.getByRole("radio")).toHaveCount(0)
  const box = (name: string) => group.getByRole("checkbox", { name })
  await expect(box("Services What you offer")).toBeChecked()
  await expect(
    box("FAQ Common questions, as a home page section")
  ).toBeChecked()
  await box("About Who is behind the business").focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Space")
  await expect(box("About Who is behind the business")).toBeChecked()
  await expect(
    box("Gallery Photos of your work, as a home page section")
  ).not.toBeChecked()
  const build = pages.getByRole("button", { name: "Build my site" })
  await expect(build).toBeEnabled()
  // Untick every box from the keyboard: with none left the question is unanswered.
  const ticked = group.getByRole("checkbox", { checked: true })
  while ((await ticked.count()) > 0) {
    await ticked.first().focus()
    await page.keyboard.press("Space")
  }
  await expect(build).toBeDisabled()
})

test("the tray is named by its question, and collapsed by its question too", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  await expect(state(page, "Palette, nothing picked")).toHaveAccessibleName(
    "Which colour palette feels right for Mop & Pail Cleaning?"
  )
  const collapsed = state(page, "Collapsed")
  await expect(collapsed).toHaveAccessibleName("Which lettering do you prefer?")
  await expect(collapsed.getByText("3 of 6", { exact: true })).toBeVisible()
})

test("with every pick made, one Looks good keeps them on any page", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const every = state(page, "Every pick made")
  await expect(every.getByText("2 of 6", { exact: true })).toBeVisible()
  await expect(every.getByRole("button", { name: "Looks good" })).toBeEnabled()
  await expect(every.getByText("I'll build your site with these")).toBeVisible()
})

test("the last question reads Build my site", async ({ page }) => {
  await open(page, "QuestionTray")
  await expect(
    state(page, "Last question, own words typed").getByRole("button", {
      name: "Build my site",
    })
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
