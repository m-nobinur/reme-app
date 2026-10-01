import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The details card: a few facts on one card, every field checked in place on
 * Continue, the picks as native radio groups. Answered and skipped cards
 * give way to the owner's reply.
 */

const pending = (page: Page) =>
  page
    .locator('[data-slot="ask-details"]')
    .filter({ has: page.locator("form") })

test("only the open cards show a form; answered and skipped ones give way", async ({
  page,
}) => {
  await open(page, "AskDetails")
  await expect(pending(page)).toHaveCount(2)
  await expect(
    page.getByText("07700 900123, sam@brightclean.example")
  ).toBeVisible()
  await expect(page.getByText("You replied in the chat instead.")).toBeVisible()
})

test("the contact card starts from the sign-in email and checks the phone", async ({
  page,
}) => {
  await open(page, "AskDetails")
  const contact = pending(page).nth(0)
  await expect(
    contact.getByRole("textbox", { name: "Email address" })
  ).toHaveValue("sam@brightclean.example")
  await contact.getByRole("button", { name: "Continue" }).click()
  await expect(contact.getByRole("alert")).toHaveText([
    "Check the phone number.",
  ])
  // The field to fix takes the focus.
  await expect(
    contact.getByRole("textbox", { name: "Phone number" })
  ).toBeFocused()
  await contact
    .getByRole("textbox", { name: "Phone number" })
    .fill("07700 900123")
  await contact.getByRole("textbox", { name: "Email address" }).fill("nope")
  await contact.getByRole("button", { name: "Continue" }).click()
  await expect(contact.getByRole("alert")).toHaveText([
    "Check the email address.",
  ])
})

test("the assistant card asks for a name, pronouns and a tone", async ({
  page,
}) => {
  await open(page, "AskDetails")
  const assistant = pending(page).nth(1)
  await assistant.getByRole("button", { name: "Continue" }).click()
  await expect(assistant.getByRole("alert")).toHaveText([
    "Check the assistant's name.",
    "Pick the pronouns.",
    "Pick the tone.",
  ])
  const pronouns = assistant.getByRole("group", { name: "Pronouns" })
  await expect(pronouns.getByRole("radio")).toHaveCount(3)
  // Arrow keys move the pick, as in any radio group.
  await pronouns.getByRole("radio").first().focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowRight")
  await expect(pronouns.getByRole("radio", { name: "she/her" })).toBeChecked()
  await expect(
    assistant.getByRole("group", { name: "Tone" }).getByRole("radio")
  ).toHaveCount(3)
  await expect(
    assistant.getByRole("button", { name: "Skip for now" })
  ).toBeVisible()
})

for (const theme of ["light", "dark"]) {
  test(`the details cards pass axe in ${theme} and fit a phone`, async ({
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
