import { expect, type Page, test } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { open } from "./helpers"

/**
 * Onboarding's choice and photo questions, in the tray: native groups the
 * keyboard can walk, the owner's own words behind Other, and photos that go
 * nowhere until the owner presses Upload. Each entry loads alone, and each
 * open question docks in a thread of its own.
 */

const pending = (page: Page) =>
  page.locator('[data-slot="ask-choice"]').filter({ has: page.locator("form") })

test("a choice is a native group, with Other opening the owner's own words", async ({
  page,
}) => {
  await open(page, "AskChoice")
  await expect(pending(page)).toHaveCount(6)
  const industry = pending(page).nth(0)
  await expect(industry.getByRole("radio")).toHaveCount(7)
  await industry.getByRole("button", { name: "Submit" }).click()
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
  await industry.getByRole("button", { name: "Submit" }).click()
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
  // Only the font question may be skipped.
  for (const [n, skips] of [0, 0, 0, 1, 0].entries()) {
    await expect(
      pending(page).nth(n).getByRole("button", { name: "Skip", exact: true })
    ).toHaveCount(skips)
  }
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

test("a choice of two answers on one tap, with no Submit", async ({ page }) => {
  await open(page, "AskChoice")
  const build = pending(page).nth(5)
  await expect(build.getByRole("button", { name: "Submit" })).toHaveCount(0)
  await expect(build.getByRole("radio")).toHaveCount(0)
  await expect(
    build.getByRole("button", { name: "Yes, build it for me" })
  ).toBeVisible()
  // The card's frame is the region the question names.
  await expect(build.getByRole("region")).toHaveAccessibleName(
    "You'll see it before it goes live"
  )
})

test("a colour card shows four, brings in four others, and takes a picked colour", async ({
  page,
}) => {
  await open(page, "AskChoice")
  const card = pending(page).nth(2)
  const first = await shownIds(card)
  expect(first).toEqual(["mint", "mist_teal", "garden", "stone_sage"])
  await card.getByText("Mint", { exact: true }).click()
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
  await card.getByRole("button", { name: "Submit" }).click()
  await expect(card.getByRole("alert")).toHaveText(
    "A colour code is # and six digits or letters from a to f."
  )
})

// The catalog scans the card's states with axe in both themes.
test("the colour card's states fit a phone", async ({ page }) => {
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
    /Skipped/,
  ])
  const done = page
    .locator('[data-slot="ask-choice"]')
    .filter({ hasNot: page.locator("form") })
  // One overtaken by a typed message leaves nothing; a broken one says so.
  await expect(done).toHaveCount(1)
  await expect(done.nth(0)).toContainText("did not come through")
})

test("a reviewed quote form leaves only a broken one's note", async ({
  page,
}) => {
  await open(page, "ReviewQuoteForm")
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveText([
    /Looks good/,
    /Ask about luggage too/,
  ])
  const done = page
    .locator('[data-slot="review-quote-form"]')
    .filter({ hasNot: page.getByRole("button", { name: "Looks good" }) })
  // A confirmed one leaves nothing, as the reply says what was saved, and
  // so does one overtaken by a typed message; a broken one says so.
  await expect(done).toHaveCount(1)
  await expect(done).toContainText("did not come through")
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
  await expect(cards).toHaveCount(6)
  const ready = cards.nth(0)
  await expect(
    ready.getByRole("heading", { name: "Brightclean website" })
  ).toBeVisible()
  await expect(ready.getByRole("button", { name: "Publish" })).toBeEnabled()
  await expect(
    ready.getByRole("button", { name: "Request changes" })
  ).toBeEnabled()
  await expect(ready.getByRole("link", { name: /Preview/ })).toHaveAttribute(
    "target",
    "_blank"
  )
  // Inside the live region after the last message, so it is read out.
  await expect(
    page.locator('[aria-live="polite"] [data-slot="site-ready"]')
  ).toHaveCount(1)
  await expect(
    cards.nth(1).getByRole("button", { name: "Publishing" })
  ).toBeDisabled()
  await expect(cards.nth(2).getByRole("alert")).toContainText("newer version")
  await expect(cards.nth(3).getByRole("link")).toHaveCount(0)
  await expect(cards.nth(4).getByRole("link")).toHaveCount(0)
  await expect(cards.nth(5)).toHaveText("Approved, publishing your website")
})

test("a docked ready card is one row above the composer that opens in place", async ({
  page,
}) => {
  await open(page, "SiteReady")
  const docked = page.locator('[data-slot="site-ready-docked"]')
  await expect(docked).toHaveCount(1)
  await expect(
    docked.getByRole("button", { name: "Publish", exact: true })
  ).toBeEnabled()
  await expect(docked.getByRole("img", { name: /home page/ })).toHaveCount(0)
  const row = docked.getByRole("button", { name: /Brightclean website/ })
  await expect(row).toHaveAttribute("aria-expanded", "false")
  await row.click()
  await expect(row).toHaveAttribute("aria-expanded", "true")
  await expect(docked.getByRole("img", { name: /home page/ })).toBeVisible()
  await expect(
    docked.getByRole("button", { name: "Request changes" })
  ).toBeEnabled()
})

test("a new chat's updates are a deck of three that steps with its arrows", async ({
  page,
}) => {
  await open(page, "UpdateDeck")
  const deck = page.getByRole("region", { name: "Updates" })
  await expect(deck.getByText("1/3")).toBeVisible()
  await expect(
    deck.getByRole("button", { name: "Publish", exact: true })
  ).toBeVisible()
  // Only the front one is there to read or press.
  await expect(deck.getByText("Which areas do you cover?")).toBeHidden()
  await deck.getByRole("button", { name: "Next update" }).click()
  await expect(deck.getByText("2/3")).toBeVisible()
  await expect(deck.getByText("Which areas do you cover?")).toBeVisible()
  await expect(
    deck.getByRole("button", { name: "Publish", exact: true })
  ).toBeHidden()
  await deck.getByRole("button", { name: "Previous update" }).click()
  await deck.getByRole("button", { name: "Previous update" }).click()
  await expect(deck.getByText("3/3")).toBeVisible()
  await expect(deck.getByText("Call the window supplier")).toBeVisible()
})
