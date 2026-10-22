import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * The conversation's ··· menu: one entry, which starts a new conversation,
 * reachable by keyboard.
 */

const actions = (page: Page) =>
  page.getByRole("button", { name: "Conversation actions" })

test("the menu holds one entry, a link to a new conversation", async ({
  page,
}) => {
  await open(page, "ConversationActions")
  await actions(page).focus()
  await page.keyboard.press("Enter")
  const items = page.getByRole("menuitem")
  await expect(items).toHaveCount(1)
  await expect(items.first()).toHaveText("New conversation")
  await expect(items.first()).toHaveAttribute("href", "#new")
})

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries({
    phone: 390,
    tablet: 768,
    desktop: 1440,
  })) {
    test(`the menu has no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, "ConversationActions", width, theme)
      await actions(page).click()
      await expect(
        page.getByRole("menuitem", { name: "New conversation" })
      ).toBeVisible()
      const results = await new AxeBuilder({ page })
        .include('[data-entry="ConversationActions"]')
        .withTags(WCAG)
        .analyze()
      expect(
        results.violations.map((v) => v.id),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([])
    })
  }
}
