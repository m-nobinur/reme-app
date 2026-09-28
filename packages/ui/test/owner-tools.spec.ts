import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

/**
 * Onboarding's two cards: a fact asked for with its own inputs, and the
 * change the owner says yes or no to. Each entry loads alone.
 */

async function open(page: Page, entry: string, width = 1024, theme = "light") {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/?entry=${entry}&theme=${theme}`)
  await expect(page.locator(`[data-entry="${entry}"]`)).toBeVisible()
}

const asks = (page: Page) => page.locator('[data-slot="ask-fact"]')

test("a question shows its own inputs, the name filled in, Skip only where allowed", async ({
  page,
}) => {
  await open(page, "AskFact")
  const forms = asks(page).locator("form")
  await expect(forms).toHaveCount(2)
  await expect(page.getByLabel("Business name")).toHaveValue("Brightclean")
  await expect(page.getByLabel("Hourly price, in pounds")).toHaveAttribute(
    "type",
    "number"
  )
  // Only pricing may be skipped.
  await expect(page.getByRole("button", { name: "Skip for now" })).toHaveCount(
    1
  )
  await expect(
    forms.nth(1).getByRole("button", { name: "Skip for now" })
  ).toBeVisible()
})

test("a question refuses a wrong answer in place, before anything is sent", async ({
  page,
}) => {
  await open(page, "AskFact")
  const form = asks(page).locator("form").first()
  await form.getByLabel("Business name").fill("")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(form.getByRole("alert")).toHaveText("Check the business name.")
  await expect(form.getByLabel("Business name")).toHaveAttribute(
    "aria-invalid",
    "true"
  )
})

test("an answered question keeps the question and what the owner said", async ({
  page,
}) => {
  await open(page, "AskFact")
  const done = asks(page).filter({ hasNot: page.locator("form") })
  await expect(done.nth(0)).toHaveText(
    /What is your business called\?\s*Brightclean/
  )
  await expect(done.nth(1)).toContainText("+447700900123")
  await expect(done.nth(2)).toContainText("Skipped")
  await expect(done.nth(3)).toContainText("Not answered")
  await expect(done.nth(4)).toContainText("did not come through")
})

test("the change card is one tap either way, and waits for the server", async ({
  page,
}) => {
  await open(page, "RequestChange")
  const cards = page.locator('[data-slot="request-change"]')
  await expect(cards).toHaveCount(13)
  const asked = cards.nth(0)
  await expect(asked.getByRole("heading")).toHaveText(
    "Build my website from the details I gave you."
  )
  await expect(asked.getByRole("button", { name: "Approve" })).toBeEnabled()
  await expect(asked.getByRole("button", { name: "Not now" })).toBeEnabled()
  // After the tap, nothing claims the build started until it has.
  const answered = cards.nth(1)
  await expect(
    answered.getByRole("button", { name: "Starting" })
  ).toBeDisabled()
  await expect(answered.getByRole("button", { name: "Not now" })).toBeDisabled()
  await expect(cards.nth(2)).toContainText("Build 5b0f6c1e")
  await expect(cards.nth(3)).toContainText("Version 4, ID 9c3e1f2a")
  await expect(cards.nth(4)).toContainText("Answer it first")
  await expect(cards.nth(5)).toContainText("You said not now.")
  await expect(cards.nth(6)).toContainText("Not started")
  // A yes that waits for the rest of its step is not starting anything yet,
  // on either card.
  const HELD = "You said yes. Sent once you answer the other cards."
  const held = cards.nth(8)
  await expect(held.getByRole("status")).toHaveText(HELD)
  // The answer is recorded and nothing runs, so the card offers no buttons.
  await expect(held.getByRole("button")).toHaveCount(0)
  await expect(held.locator('[aria-busy="true"]')).toHaveCount(0)
  const heldQuestions = page.locator(
    '[data-slot="answer-question"] [role="status"]'
  )
  await expect(heldQuestions.nth(0)).toHaveText(HELD)
  await expect(
    cards.nth(9).getByRole("button", { name: "Approve" })
  ).toBeEnabled()
  // And a no, on either card.
  const NOT_NOW = "You said not now. Sent once you answer the other cards."
  await expect(cards.nth(10).getByRole("status")).toHaveText(NOT_NOW)
  await expect(heldQuestions.nth(1)).toHaveText(NOT_NOW)
  // A yes already sent, with no other card in its step, is starting.
  const sent = cards.nth(12)
  await expect(sent.getByRole("button", { name: "Starting" })).toBeDisabled()
  await expect(sent.getByRole("status")).toHaveCount(0)
  await expect(sent.locator('[aria-busy="true"]')).toHaveCount(1)
})

test("the approve button shows a visible focus ring from the keyboard", async ({
  page,
}) => {
  await open(page, "RequestChange")
  const approve = page
    .locator('[data-slot="request-change"]')
    .first()
    .getByRole("button", { name: "Approve" })
  await approve.focus()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  await expect(approve).toBeFocused()
  const ring = await approve.evaluate(
    (node) => getComputedStyle(node).boxShadow
  )
  expect(ring).not.toBe("none")
})

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries({
    phone: 390,
    tablet: 768,
    desktop: 1440,
  })) {
    for (const entry of ["Onboarding", "AskFact", "RequestChange"]) {
      test(`${entry} has no accessibility violations on a ${name} in ${theme}`, async ({
        page,
      }) => {
        await open(page, entry, width, theme)
        const results = await new AxeBuilder({ page })
          .include(`[data-entry="${entry}"]`)
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze()
        expect(
          results.violations.map((violation) => violation.id),
          JSON.stringify(results.violations, null, 2)
        ).toEqual([])
      })
    }
  }
}

test("a message of cards alone has no copy row", async ({ page }) => {
  await open(page, "Onboarding")
  await expect(page.getByRole("button", { name: "Copy" })).toHaveCount(0)
})

for (const width of [390, 1440]) {
  test(`a conversation has one h1 at ${width}`, async ({ page }) => {
    // A thread with messages: the welcome and its heading are gone.
    await open(page, "Thread", width)
    await expect(page.locator("h1")).toHaveCount(1)
    const results = await new AxeBuilder({ page })
      .withRules(["page-has-heading-one"])
      .analyze()
    expect(results.violations.map((violation) => violation.id)).toEqual([])
  })
}
