import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * Onboarding's choice and photo cards: native groups the keyboard can walk,
 * the owner's own words behind Other, and photos that go nowhere until the
 * owner presses Upload. Each entry loads alone.
 */

const pending = (page: Page) =>
  page.locator('[data-slot="ask-choice"]').filter({ has: page.locator("form") })

test("a choice is a native group, with Other opening the owner's own words", async ({
  page,
}) => {
  await open(page, "AskChoice")
  await expect(pending(page)).toHaveCount(5)
  const industry = pending(page).nth(0)
  await expect(industry.getByRole("radio")).toHaveCount(7)
  await industry.getByRole("button", { name: "Continue" }).click()
  await expect(industry.getByRole("alert")).toHaveText("Pick one first.")
  // Arrow keys move the choice, as in any radio group.
  await industry.getByRole("radio").first().focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowRight")
  await expect(
    industry.getByRole("radio", { name: "Limousine and chauffeur hire" })
  ).toBeChecked()
  await industry.getByText("Something else").click()
  const words = industry.getByRole("textbox", { name: "Something else" })
  await expect(words).toHaveAttribute("placeholder", "Your industry")
  await industry.getByRole("button", { name: "Continue" }).click()
  await expect(industry.getByRole("alert")).toHaveText(
    "Write your answer first."
  )
  // The template and tone cards open on what the call preselected.
  await expect(
    pending(page)
      .nth(4)
      .getByRole("radio", { name: /Modern/ })
  ).toBeChecked()
  await expect(
    pending(page)
      .nth(1)
      .getByRole("radio", { name: /Friendly/ })
  ).toBeChecked()
  // Only the font card may be skipped.
  await expect(page.getByRole("button", { name: "Skip for now" })).toHaveCount(
    1
  )
})

test("an answered choice reads back in the owner's words", async ({ page }) => {
  await open(page, "AskChoice")
  const done = page
    .locator('[data-slot="ask-choice"]')
    .filter({ hasNot: page.locator("form") })
  await expect(done.nth(0)).toHaveText("they/them")
  await expect(done.nth(1)).toHaveText("Navy and gold")
  await expect(done.nth(2)).toContainText("Skipped")
  await expect(done.nth(3)).toContainText("You replied in the chat instead.")
  await expect(done.nth(4)).toContainText("did not come through")
})

const PNG = {
  name: "van.png",
  mimeType: "image/png",
  // A 1x1 PNG.
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ),
}

test("photos preview, can be taken out, and are sent only on Upload", async ({
  page,
}) => {
  await open(page, "AskUpload")
  const card = page
    .locator('[data-slot="ask-upload"]')
    .filter({ has: page.locator('input[type="file"]') })
  const upload = card.getByRole("button", { name: "Upload photos" })
  await expect(upload).toBeDisabled()
  await card.locator('input[type="file"]').setInputFiles([
    PNG,
    {
      name: "logo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    },
  ])
  await expect(card.getByRole("img", { name: "van.png" })).toBeVisible()
  await expect(card.getByRole("alert")).toHaveText(
    "logo.svg is not a JPEG, PNG or WebP photo."
  )
  await card.getByRole("button", { name: "Remove van.png" }).click()
  await expect(card.getByRole("img")).toHaveCount(0)
  await expect(upload).toBeDisabled()
  await card.locator('input[type="file"]').setInputFiles([PNG])
  await upload.click()
  await expect(card.getByRole("status")).toHaveText("Uploading 1 photo")
  // The catalog's runtime takes no tool results, so the answer fails here
  // after the upload, which shows the failure state: a reason, and the
  // photos kept for another try.
  await expect(card.getByRole("alert")).toBeVisible()
  await expect(upload).toBeEnabled()
  await expect(card.getByRole("img", { name: "van.png" })).toBeVisible()
})
