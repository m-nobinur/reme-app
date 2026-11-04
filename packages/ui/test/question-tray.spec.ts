import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The question tray: a native radio group the keyboard walks, Enter for Next,
 * Escape to collapse, and the last question's Done. Each state in the
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
  await expect(first.getByText("4 of 7", { exact: true })).toBeVisible()
  await expect(first.getByRole("radiogroup")).toHaveAccessibleName(
    "Which lettering do you prefer?"
  )
})

test("Escape collapses to one row and the row opens it again", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const first = state(page, "Palette, nothing picked")
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
  const build = pages.getByRole("button", { name: "Done" })
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
  await expect(collapsed.getByText("4 of 7", { exact: true })).toBeVisible()
})

test("with every pick made, a page before the last reads Next and leaves Pick for me out", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const every = state(page, "Every pick made")
  await expect(every.getByText("3 of 7", { exact: true })).toBeVisible()
  await expect(
    every.getByRole("button", { name: "Next", exact: true })
  ).toBeEnabled()
  await expect(every.getByRole("button", { name: "Pick for me" })).toHaveCount(
    0
  )
})

test("the last question reads Done", async ({ page }) => {
  await open(page, "QuestionTray")
  await expect(
    state(page, "Last question, own words typed").getByRole("button", {
      name: "Done",
    })
  ).toBeEnabled()
})

// The catalog scans the tray at 1024 in both themes.
test("the tray has no accessibility violations on a phone", async ({
  page,
}) => {
  await open(page, "QuestionTray", 360)
  await axe(page, "QuestionTray 360")
})

test("the logo question answers from the keyboard in one press, with no Next", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const logo = state(page, "Logo, nothing chosen")
  await expect(logo.getByRole("radio")).toHaveCount(0)
  await expect(logo.getByRole("button", { name: "Next" })).toHaveCount(0)
  const create = logo.getByRole("button", { name: /No, create one for me/ })
  await expect(create).toHaveAttribute("aria-pressed", "false")
  await create.focus()
  await page.keyboard.press("Enter")
  await expect(logo.getByRole("heading")).toHaveText(
    /Designing your logo|Pick your logo/
  )
})

test("an idea for a redesign toggles from the keyboard, and Change the brief moves into What should change?", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const picked = state(page, "Logo, a design picked")
  await expect(picked.getByRole("heading")).toHaveText("Pick your logo")
  const idea = picked.getByRole("button", { name: "Old-school feel" })
  await idea.focus()
  await page.keyboard.press("Space")
  await expect(idea).toHaveAttribute("aria-pressed", "true")
  await expect(
    picked.getByRole("textbox", { name: "What should change?" })
  ).toHaveValue("an old-school, heritage feel")
  await expect(
    picked.getByRole("button", { name: "Redesign my logo" })
  ).toBeEnabled()
  await page.keyboard.press("Space")
  await expect(idea).toHaveAttribute("aria-pressed", "false")

  const fresh = state(page, "Logo, its ideas late: the fixed ones")
  await expect(fresh.getByRole("button", { name: "Bolder" })).toBeVisible()
  await fresh.getByRole("button", { name: "Change the brief" }).click()
  await expect(
    fresh.getByRole("textbox", { name: "What should change?" })
  ).toBeFocused()
})

test("a design read that fails says so and stops asking until Try again", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  for (const title of [
    "Logo, the designs could not be read",
    "Logo, a read failed while drawing",
  ]) {
    const logo = state(page, title)
    const failed = logo.getByText("Your designs did not load.")
    const designs = logo.getByRole("radiogroup", { name: "Logo designs" })
    await expect(failed).toBeVisible({ timeout: 8000 })
    await expect(designs.getByRole("radio")).toHaveCount(0)
    await expect(logo.getByRole("button", { name: /Redesign/ })).toHaveCount(0)
    // Longer than the poll that would otherwise ask again and bring them back.
    await page.waitForTimeout(3500)
    await expect(failed).toBeVisible()
    await logo.getByRole("button", { name: "Try again" }).click()
    await expect(designs.getByRole("radio")).toHaveCount(3)
    await expect(failed).toBeHidden()
  }
})

test("a focused tile takes the shared ring and a picked one keeps its one line", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const tile = state(page, "Palette, one picked").getByRole("radio").nth(1)
  const line = () =>
    tile.evaluate((input) => {
      const style = getComputedStyle(input.closest("label") as Element)
      return {
        border: style.borderTopColor,
        outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
        ring: style.boxShadow,
      }
    })
  await tile.focus()
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowRight")
  await expect(tile).toBeChecked()
  const focused = await line()
  expect(focused.outline).toMatch(/^1px solid /)
  expect(focused.ring).toContain("0px 0px 0px 3px")
  await tile.evaluate((input) => (input as HTMLElement).blur())
  const resting = await line()
  expect(resting.ring).toBe("none")
  expect(focused.outline.split(" ").slice(2)).toEqual(
    resting.outline.split(" ").slice(2)
  )
})

test("a focused field turns its border and draws no ring, as the shared Input does", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const field = state(page, "Logo, an idea picked: Redesign my logo").getByRole(
    "textbox",
    { name: "What should change?" }
  )
  await field.focus()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  const { border, ring, token } = await field.evaluate((box) => {
    const style = getComputedStyle(box)
    const probe = document.createElement("div")
    probe.style.borderTop = "1px solid var(--field-focus)"
    document.body.append(probe)
    const focusColour = getComputedStyle(probe).borderTopColor
    probe.remove()
    return {
      border: style.borderTopColor,
      ring: style.boxShadow,
      token: focusColour,
    }
  })
  expect(border).toBe(token)
  expect(ring).toBe("none")
})

test("lettering shows four styles and More styles shows them all", async ({
  page,
}) => {
  await open(page, "QuestionTray")
  const lettering = state(page, "Lettering, may be skipped")
  await expect(lettering.getByRole("radio")).toHaveCount(4)
  await expect(lettering.getByText(/Suggested for /)).toHaveCount(0)
  await lettering.getByRole("button", { name: "More styles" }).click()
  await expect(lettering.getByRole("radio")).toHaveCount(8)
})
