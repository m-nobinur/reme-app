import { expect, type Page, test } from "@playwright/test"
import { PALETTES } from "@workspace/contracts"
import { axe, open, settled } from "./helpers"

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
  await expect(pending(page)).toHaveCount(5)
  const industry = pending(page).nth(0)
  await expect(industry.getByRole("radio")).toHaveCount(7)
  await industry.getByRole("button", { name: "Done" }).click()
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
  await industry.getByRole("button", { name: "Done" }).click()
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

test("a choice of two short answers is quick replies above the composer", async ({
  page,
}) => {
  await open(page, "AskChoice")
  const build = page
    .locator('[data-slot="ask-choice"]')
    .getByRole("group", { name: "Would you like me to build your website?" })
  await expect(build.getByRole("button")).toHaveText([
    "Yes, build my website",
    "No, I already have one",
  ])
  await expect(
    page.locator('[data-slot="ask-choice"]').getByRole("region", {
      name: "Would you like me to build your website?",
    })
  ).toHaveCount(0)
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
  await card.getByRole("button", { name: "Done" }).click()
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
    .filter({ hasNot: page.locator("form, [data-slot=reply-pills]") })
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
  // The catalog's upload refuses a file named broken, which shows the
  // failure state: a reason, and the photos kept for another try.
  await card
    .locator('input[type="file"]')
    .setInputFiles([{ ...PNG, name: "broken.png" }])
  await upload.click()
  await expect(card.getByRole("status")).toHaveText("Uploading 1 photo")
  await expect(card.getByRole("alert")).toBeVisible()
  await expect(upload).toBeEnabled()
  await expect(card.getByRole("img", { name: "broken.png" })).toBeVisible()
})

test("the ready card sits at the end of the thread and never claims an approval early", async ({
  page,
}) => {
  await open(page, "SiteReady")
  const cards = page.locator('[data-slot="site-ready"]')
  await expect(cards).toHaveCount(9)
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
  await expect(cards.nth(2)).toContainText(
    "Publishing waits until your update is ready."
  )
  await expect(cards.nth(3).getByRole("alert")).toContainText("newer version")
  await expect(cards.nth(4).getByRole("link")).toHaveCount(0)
  await expect(cards.nth(5).getByRole("link")).toHaveCount(0)
  await expect(cards.nth(6)).toHaveText("Approved, publishing your website")
  // A step beside Publish, on the same row, for the web address and then Search Console.
  for (const [at, label] of [
    [7, "Connect"],
    [8, "Connect Search Console"],
  ] as const) {
    const publish = await cards
      .nth(at)
      .getByRole("button", { name: "Publish" })
      .boundingBox()
    const connect = cards
      .nth(at)
      .getByRole("button", { name: label, exact: true })
    const beside = await connect.boundingBox()
    expect(publish && beside && Math.abs(publish.y - beside.y) < 8).toBe(true)
    expect(publish && beside && beside.x + beside.width <= publish.x).toBe(true)
  }
  await expect(
    cards.nth(0).getByRole("button", { name: /^Connect/ })
  ).toHaveCount(0)
})

test("the ready cards with a step beside Publish fit a phone and pass axe", async ({
  page,
}) => {
  await open(page, "SiteReady", 390)
  await axe(page, "SiteReady 390")
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
  ).toBe(false)
  const card = page.locator('[data-slot="site-ready"]').nth(8)
  const box = await card.boundingBox()
  const connect = await card
    .getByRole("button", { name: "Connect Search Console" })
    .boundingBox()
  expect(box && connect && connect.x >= box.x).toBe(true)
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

test("a choice pill opens its options and hint, and a cut label shows whole on hover", async ({
  page,
}) => {
  await open(page, "ReviewQuoteForm")
  await page
    .getByRole("button", { name: "Vehicle, one choice: show the options" })
    .first()
    .click()
  const options = page.getByRole("dialog", { name: "Vehicle" })
  await expect(options).toContainText("The minibus seats up to 16")
  await expect(options.getByRole("listitem")).toHaveText([
    "Saloon",
    "Stretch limousine",
    "Minibus",
  ])
  await expect(options).toContainText("Customers pick one.")
  await page.keyboard.press("Escape")
  await expect(options).toHaveCount(0)
  await page
    .getByText("Anything else we should know before we quote", { exact: true })
    .first()
    .hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    "Anything else we should know before we quote"
  )
  // A choice pill is a button of its own, and its cut label still shows whole.
  await page.mouse.move(0, 0)
  await page
    .getByRole("button", { name: /^Is there parking outside the property/ })
    .first()
    .hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    "Is there parking outside the property for the driver to use"
  )
})

test("a finished design tray reads back as chips: the logo, colours, a pair in its own face", async ({
  page,
}) => {
  await open(page, "DesignReply")
  const bubble = page.locator('[data-slot="aui_user-message-root"]')
  await expect(bubble.locator("img")).toHaveCount(1)
  await expect(bubble.getByText("Outfit and Figtree")).toHaveCSS(
    "font-family",
    /^"?Outfit"?,/
  )
  for (const words of [
    "Logo",
    "Text left, photo in an arch",
    "Photos made for me",
    "Services, About",
  ]) {
    await expect(bubble.getByText(words, { exact: true })).toBeVisible()
  }
})

// A chip is a light tint of the bubble with a hairline edge, never a patch of
// the page's own colour: dark holes in dark mode, white ones in light.
for (const theme of ["light", "dark"]) {
  test(`the design reply's chips tint the bubble, ${theme}`, async ({
    page,
  }) => {
    await open(page, "DesignReply", 1024, theme)
    const bubble = page.locator('[data-slot="aui_user-message-root"]')
    const looks = await bubble
      .locator(".rounded-full.border, img")
      .evaluateAll((all) =>
        all.map((each) => {
          const style = getComputedStyle(each)
          return [style.backgroundColor, style.borderTopColor]
        })
      )
    expect(looks.length).toBeGreaterThan(4)
    for (const [background, border] of looks) {
      expect(background).toMatch(/ 0\.04\)$/)
      if (border && !border.endsWith(" 0)")) expect(border).toMatch(/ 0\.1\)$/)
    }
    await axe(page, `DesignReply ${theme}`)
  })
}

test("the quote form preview is the customers' form, live but never sent, and confirms like the card", async ({
  page,
}) => {
  await open(page, "QuoteFormPreview")
  const trigger = page.getByRole("button", { name: "Preview form" })
  await trigger.click()
  const modal = page.getByRole("dialog", { name: "Form preview" })
  await expect(modal).toBeVisible()

  await expect(modal.getByRole("group")).toHaveCount(5)
  await expect(modal.getByRole("group", { name: "Your details" })).toBeVisible()
  await expect(modal.getByRole("group", { name: "Your request" })).toBeVisible()
  for (const label of [
    "Your name",
    "Email address",
    "Phone number optional",
    "What do you need doing",
    "Tell us more optional",
    "Passengers",
    "Day of the journey",
    "Date and time of the journey",
    "Occasion optional",
    "Photos of the pick-up point optional",
    "A second number optional",
    "Email for the invoice optional",
  ]) {
    await expect(modal.getByLabel(label, { exact: true })).toBeVisible()
  }
  await expect(modal.getByLabel("Passengers")).toHaveAttribute("type", "number")
  await expect(
    modal.getByLabel("Date and time of the journey")
  ).toHaveAttribute("type", "datetime-local")
  await expect(modal.getByLabel("Day of the journey")).toHaveAttribute(
    "type",
    "date"
  )
  await expect(
    modal.getByLabel("Photos of the pick-up point optional")
  ).toHaveAttribute("type", "file")
  await expect(modal.getByLabel("A second number optional")).toHaveAttribute(
    "type",
    "tel"
  )
  await expect(modal).toContainText("The minibus seats up to 16")
  await expect(modal).toContainText("A line is enough")
  // A text field's hint sits between its label and the input, as on the site.
  const summary = modal.getByLabel("What do you need doing", { exact: true })
  await expect(summary).toHaveAccessibleDescription("A line is enough")
  const [label, line, input] = await Promise.all([
    modal.getByText("What do you need doing", { exact: true }).boundingBox(),
    modal.getByText("A line is enough").boundingBox(),
    summary.boundingBox(),
  ])
  expect(label && line && label.y + label.height <= line.y).toBe(true)
  expect(line && input && line.y + line.height <= input.y).toBe(true)

  // Three short options are buttons, with the hint under the label and above them.
  const parking = modal.getByRole("group", {
    name: "Is there parking outside the property for the driver to use",
  })
  await expect(parking.getByRole("radio")).toHaveCount(3)
  await expect(modal.locator("select")).toHaveCount(1)
  const hint = await parking.getByText("Permits are not needed").boundingBox()
  const first = await parking.getByText("Off-street").boundingBox()
  expect(hint && first && hint.y + hint.height <= first.y).toBe(true)
  await parking.getByText("On-street").click()
  await expect(parking.getByRole("radio", { name: "On-street" })).toBeChecked()

  await modal.getByLabel("Your name").fill("Sam")
  await expect(modal.getByLabel("Your name")).toHaveValue("Sam")
  await modal.getByLabel("Occasion optional").selectOption("Night out")
  await expect(modal.getByLabel("Occasion optional")).toHaveValue("Night out")
  const vehicle = modal.getByRole("group", { name: "Vehicle" })
  await vehicle.getByText("Saloon", { exact: true }).click()
  await vehicle.getByText("Minibus", { exact: true }).click()
  await expect(vehicle.getByRole("radio", { name: "Saloon" })).not.toBeChecked()
  const extras = modal.getByRole("group", { name: "Extras optional" })
  await extras.getByRole("checkbox", { name: "Child seat" }).check()
  await extras.getByRole("checkbox", { name: "Champagne" }).check()
  await expect(extras.getByRole("checkbox", { checked: true })).toHaveCount(2)

  const send = modal.getByRole("button", { name: "Send quote request" })
  await expect(send).toBeDisabled()
  await expect(modal).toContainText(
    "This is a preview, so nothing is sent or saved."
  )

  await axe(page, "QuoteFormPreview light")

  // Closing forgets the answers, and focus goes back to the button.
  await page.keyboard.press("Escape")
  await expect(modal).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(modal.getByLabel("Your name")).toHaveValue("")
  await expect(
    modal.getByRole("button", { name: "Close preview" })
  ).toHaveCount(0)
  await modal.getByRole("button", { name: "Close", exact: true }).click()
  await expect(modal).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await modal.getByRole("button", { name: "Looks good" }).click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByRole("status")).toHaveText("Confirmed")
})

test("the quote form preview keeps focus inside, rises from the bottom on a phone and has no violations", async ({
  page,
}) => {
  await open(page, "QuoteFormPreview", 390)
  await page.getByRole("button", { name: "Preview form" }).click()
  const modal = page.getByRole("dialog", { name: "Form preview" })
  await expect(modal).toBeVisible()
  await settled(page)
  const box = await modal.boundingBox()
  expect(box?.x).toBe(0)
  expect(box?.width).toBe(390)
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBe(900)
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab")
    // Base UI's guards sit at both ends and hand focus back in a tick later.
    await expect
      .poll(
        () =>
          modal.evaluate(
            (el) =>
              el.contains(document.activeElement) &&
              !document.activeElement?.hasAttribute("data-base-ui-focus-guard")
          ),
        { message: `focus left the sheet on Tab ${i + 1}` }
      )
      .toBe(true)
  }
  await axe(page, "QuoteFormPreview phone")

  await open(page, "QuoteFormPreview", 1024, "dark")
  await page.getByRole("button", { name: "Preview form" }).click()
  await expect(page.getByRole("dialog", { name: "Form preview" })).toBeVisible()
  await settled(page)
  await axe(page, "QuoteFormPreview dark")
})

test("the card's Preview form shows the questions as the owner has left them, and Looks good there confirms", async ({
  page,
}) => {
  await open(page, "ReviewQuoteForm")
  const card = page
    .locator('[data-slot="review-quote-form"]')
    .filter({ has: page.getByRole("button", { name: "Looks good" }) })
    .first()
  await card.getByRole("button", { name: "Remove Occasion" }).click()
  await card.getByRole("button", { name: "Preview form" }).click()
  const modal = page.getByRole("dialog", { name: "Form preview" })
  await expect(modal.getByRole("group", { name: "Your details" })).toBeVisible()
  await expect(modal.getByLabel("Pick-up address")).toBeVisible()
  await expect(modal.getByLabel(/^Occasion/)).toHaveCount(0)
  // The card's own confirm runs, and the catalog takes its answer quietly.
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await modal.getByRole("button", { name: "Looks good" }).click()
  await expect(modal).toHaveCount(0)
  expect(errors).toEqual([])
})
