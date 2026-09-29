import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * Renaming and archiving a conversation from its ··· menu, by keyboard. The
 * title becomes a form in place, and every way out of it hands focus back
 * to the ··· button.
 */

const actions = (page: Page) =>
  page.getByRole("button", { name: "Conversation actions" })
const title = (page: Page) => page.locator('[data-slot="workspace-title"]')
const field = (page: Page) =>
  page.getByRole("textbox", { name: "Conversation title" })

async function choose(page: Page, item: string) {
  await actions(page).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: item }).focus()
  await page.keyboard.press("Enter")
}

test("renames in place from the keyboard, and hands focus back", async ({
  page,
}) => {
  await open(page, "ConversationRename")
  await choose(page, "Rename")
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue("Weekend prices")
  await field(page).fill("  Saturday   hours ")
  await page.keyboard.press("Enter")
  await expect(title(page)).toHaveText("Saturday hours")
  await expect(actions(page)).toBeFocused()
})

test("Escape leaves the title as it was", async ({ page }) => {
  await open(page, "ConversationRename")
  await choose(page, "Rename")
  await field(page).fill("Something else")
  await page.keyboard.press("Escape")
  await expect(title(page)).toHaveText("Weekend prices")
  await expect(actions(page)).toBeFocused()
})

test("a title of only spaces, or one the server refuses, stays in the form with why", async ({
  page,
}) => {
  await open(page, "ConversationRename")
  await choose(page, "Rename")
  await field(page).fill("   ")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alert")).toHaveText("A title needs words.")
  await expect(field(page)).toHaveAttribute("aria-invalid", "true")

  await field(page).fill("Will not save")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "That did not save. Try again."
  )
  await expect(field(page)).toBeEnabled()
})

test("an archive that fails says so beside the title", async ({ page }) => {
  await open(page, "ConversationRename")
  await choose(page, "Archive")
  await expect(page.getByRole("alert")).toHaveText(
    "That did not archive. Try again."
  )
  await expect(title(page)).toHaveText("Weekend prices")
})

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries({
    phone: 390,
    tablet: 768,
    desktop: 1440,
  })) {
    test(`the menu and the rename form have no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, "ConversationRename", width, theme)
      const scan = async (label: string) => {
        const results = await new AxeBuilder({ page })
          .include('[data-entry="ConversationRename"]')
          .withTags(WCAG)
          .analyze()
        expect
          .soft(
            results.violations.map((v) => `${label}: ${v.id}`),
            JSON.stringify(results.violations, null, 2)
          )
          .toEqual([])
      }
      await actions(page).click()
      await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible()
      await scan("menu")
      await page.getByRole("menuitem", { name: "Rename" }).click()
      await field(page).fill(" ")
      await page.keyboard.press("Enter")
      await expect(page.getByRole("alert")).toBeVisible()
      await scan("form")
    })
  }
}
