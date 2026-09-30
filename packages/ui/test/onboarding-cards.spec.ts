import { expect, type Page, test } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { axe, open } from "./helpers"

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

/** The values of the options a card shows, Other left out. */
const shownIds = (card: ReturnType<typeof pending>) =>
  card
    .getByRole("radio")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node as HTMLInputElement).value)
        .filter((value) => value !== "__other__")
    )

test("a colour card shows four, brings in four others, and takes a picked colour", async ({
  page,
}) => {
  await open(page, "AskChoice")
  const card = pending(page).nth(2)
  const first = await shownIds(card)
  expect(first).toEqual(["ocean", "lagoon", "sunset", "damson"])
  await card.getByText("Ocean", { exact: true }).click()
  await card.getByRole("button", { name: "Show other colours" }).click()
  const second = await shownIds(card)
  expect(second).toHaveLength(4)
  expect(second.filter((id) => first.includes(id))).toEqual([])
  // The pick went with its card, and the new four are read out.
  await expect(card.getByRole("radio", { checked: true })).toHaveCount(0)
  await expect(card.locator("[aria-live=polite]")).toHaveText(/^Showing .+\.$/)
  // The button keeps focus, so the next press is one key away.
  await expect(
    card.getByRole("button", { name: "Show other colours" })
  ).toBeFocused()

  await card.getByText("Your own colour").click()
  const field = card.getByRole("textbox", { name: "Your own colour" })
  const picker = card.getByLabel("Pick a colour")
  const light = PALETTES[0]?.swatches[1] ?? ""
  await field.fill(light.toUpperCase())
  await expect(picker).toHaveValue(light)
  await expect(card.getByText(/hard to read/)).toBeVisible()
  const dark = PALETTES[2]?.brand ?? ""
  await picker.fill(dark)
  await expect(field).toHaveValue(dark)
  await expect(card.getByText(/reads well/)).toBeVisible()
  await field.fill("#12")
  await card.getByRole("button", { name: "Continue" }).click()
  await expect(card.getByRole("alert")).toHaveText(
    "A colour code is # and six digits or letters from a to f."
  )
})

test("the colour card's states pass axe in both themes and fit a phone", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await open(page, "ChoiceForm", 1024, theme)
    await axe(page, `ChoiceForm ${theme}`)
  }
  await open(page, "ChoiceForm", 375)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  )
  expect(overflow).toBe(false)
})

test("an answered choice reads back as the owner's reply", async ({ page }) => {
  await open(page, "AskChoice")
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveText([
    /they\/them/,
    /Navy and gold/,
    /Skip for now/,
  ])
  const done = page
    .locator('[data-slot="ask-choice"]')
    .filter({ hasNot: page.locator("form") })
  await expect(done).toHaveCount(2)
  await expect(done.nth(0)).toContainText("You replied in the chat instead.")
  await expect(done.nth(1)).toContainText("did not come through")
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

test("the ready card sits at the end of the thread and never claims an approval early", async ({
  page,
}) => {
  await open(page, "SiteReady")
  const cards = page.locator('[data-slot="site-ready"]')
  await expect(cards).toHaveCount(4)
  const ready = cards.nth(0)
  await expect(
    ready.getByRole("heading", { name: "Your website is ready." })
  ).toBeVisible()
  await expect(ready.getByRole("button", { name: "Approve" })).toBeEnabled()
  await expect(
    ready.getByRole("button", { name: "Make changes" })
  ).toBeEnabled()
  await expect(
    ready.getByRole("button", { name: "See the preview" })
  ).toBeVisible()
  // Inside the live region after the last message, so it is read out.
  await expect(
    page.locator('[aria-live="polite"] [data-slot="site-ready"]')
  ).toHaveCount(1)
  await expect(
    cards.nth(1).getByRole("button", { name: "Approving" })
  ).toBeDisabled()
  await expect(cards.nth(2).getByRole("alert")).toContainText("newer version")
  await expect(cards.nth(3)).toHaveText(
    "Approved. Version 3 is being published."
  )
})
