import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The details tray: one field per page, each checked as the owner leaves it,
 * the picks as native radio groups, and Submit on the last page. Answered
 * and skipped asks give way to the owner's reply. Each open ask is docked in
 * a thread of its own.
 */

const pending = (page: Page) =>
  page
    .locator('[data-slot="ask-details"]')
    .filter({ has: page.locator("form") })

test("only the open asks show a tray; answered and skipped ones give way", async ({
  page,
}) => {
  await open(page, "AskDetails")
  await expect(pending(page)).toHaveCount(2)
  await expect(
    page.getByText("07700 900123 · sam@brightclean.example")
  ).toBeVisible()
  await expect(page.getByText("You replied in the chat instead.")).toBeVisible()
})

test("the contact tray checks the phone, then starts the email from the sign-in", async ({
  page,
}) => {
  await open(page, "AskDetails")
  const contact = pending(page).nth(0)
  await expect(contact.getByText("1 of 2")).toBeVisible()
  await contact.getByRole("button", { name: "Next", exact: true }).click()
  await expect(contact.getByRole("alert")).toHaveText([
    "Check the phone number.",
  ])
  // The field to fix takes the focus.
  const phone = contact.getByRole("textbox", { name: "Phone number" })
  await expect(phone).toBeFocused()
  await phone.fill("07700 900123")
  // Enter in the field moves on, as Next does.
  await page.keyboard.press("Enter")
  await expect(contact.getByText("2 of 2")).toBeVisible()
  await expect(
    contact.getByRole("textbox", { name: "Email address" })
  ).toHaveValue("sam@brightclean.example")
  await expect(
    contact.getByText(
      "Shown on your website. Use a business address if you have one."
    )
  ).toBeVisible()
  await contact.getByRole("textbox", { name: "Email address" }).fill("nope")
  await contact.getByRole("button", { name: "Submit" }).click()
  await expect(contact.getByRole("alert")).toHaveText([
    "Check the email address.",
  ])
  // Back finds the phone as it was typed.
  await contact.getByRole("button", { name: "Previous question" }).click()
  await expect(phone).toHaveValue("07700 900123")
})

test("the assistant tray asks for a name, pronouns and a tone, a page each", async ({
  page,
}) => {
  await open(page, "AskDetails")
  const assistant = pending(page).nth(1)
  await expect(assistant.getByText("1 of 3")).toBeVisible()
  await expect(
    assistant.getByRole("button", { name: "Skip all" })
  ).toBeVisible()
  await assistant.getByRole("button", { name: "Next", exact: true }).click()
  await expect(assistant.getByRole("alert")).toHaveText([
    "Check the assistant's name.",
  ])
  await assistant.getByRole("textbox", { name: "Assistant's name" }).fill("Ava")
  await assistant.getByRole("button", { name: "Next", exact: true }).click()
  const pronouns = assistant.getByRole("group", { name: "Pronouns" })
  await expect(pronouns.getByRole("radio")).toHaveCount(3)
  // Arrow keys move the pick, as in any radio group.
  await pronouns.getByRole("radio").first().focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowRight")
  await expect(pronouns.getByRole("radio", { name: "she/her" })).toBeChecked()
  await assistant.getByRole("button", { name: "Next", exact: true }).click()
  await expect(
    assistant.getByRole("group", { name: "Tone" }).getByRole("radio")
  ).toHaveCount(3)
  await expect(assistant.getByRole("button", { name: "Submit" })).toBeVisible()
})

test("Escape collapses the tray to its question and the count", async ({
  page,
}) => {
  await open(page, "AskDetails")
  const contact = pending(page).nth(0)
  await contact.getByRole("textbox", { name: "Phone number" }).focus()
  await page.keyboard.press("Escape")
  const row = page
    .locator('[data-slot="ask-details"]')
    .first()
    .getByRole("button", { expanded: false })
  await expect(row).toContainText("What number should customers ring?")
  await expect(row).toContainText("1 of 2")
})

for (const theme of ["light", "dark"]) {
  test(`the details trays pass axe in ${theme} and fit a phone`, async ({
    page,
  }) => {
    await open(page, "AskDetails", 390, theme)
    await axe(page, `AskDetails ${theme}`)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
    expect(overflow).toBe(false)
  })
}
