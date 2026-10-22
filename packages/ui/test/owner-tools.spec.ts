import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * Onboarding's two cards: a fact asked for with its own inputs, and the
 * change the owner says yes or no to. Each entry loads alone.
 */

const asks = (page: Page) => page.locator('[data-slot="ask-fact"]')

test("a question shows its own inputs, the email filled in, Skip only where allowed", async ({
  page,
}) => {
  await open(page, "AskFact")
  const forms = asks(page).locator("form")
  await expect(forms).toHaveCount(2)
  await expect(page.getByLabel("Email address")).toHaveValue(
    "hello@brightclean.test"
  )
  await expect(forms.nth(1).getByLabel("Opening time")).toHaveAttribute(
    "type",
    "time"
  )
  // Only the hours may be skipped; the button sits in the tray's footer.
  await expect(
    page.getByRole("button", { name: "Skip", exact: true })
  ).toHaveCount(1)
  await expect(
    asks(page)
      .filter({ has: page.locator("form") })
      .nth(1)
      .getByRole("button", { name: "Skip", exact: true })
  ).toBeVisible()
})

test("a question refuses a wrong answer in place, before anything is sent", async ({
  page,
}) => {
  await open(page, "AskFact")
  const tray = asks(page)
    .filter({ has: page.locator("form") })
    .first()
  const form = tray.locator("form")
  await form.getByLabel("Email address").fill("")
  await tray.getByRole("button", { name: "Submit" }).click()
  await expect(form.getByRole("alert")).toHaveText(
    "Enter an email address, like hello@yourbusiness.co.uk."
  )
  await expect(form.getByLabel("Email address")).toHaveAttribute(
    "aria-invalid",
    "true"
  )
})

test("an answered question gives way to the owner's reply, each step its own message", async ({
  page,
}) => {
  await open(page, "AskFact")
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveText([
    /Brightclean/,
    /\+447700900123/,
    /Skipped/,
  ])
  // An answered or skipped question shows nothing; one not answered says why.
  const done = asks(page).filter({ hasNot: page.locator("form") })
  await expect(done).toHaveCount(2)
  await expect(done.nth(0)).toContainText("You replied in the chat instead.")
  await expect(done.nth(1)).toContainText("did not come through")
})

test("the change card is one tap either way, and waits for the server", async ({
  page,
}) => {
  await open(page, "RequestChange")
  const cards = page.locator('[data-slot="request-change"]')
  await expect(cards).toHaveCount(15)
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
  // A started build names no version, id or hash.
  for (const started of [cards.nth(2), cards.nth(3)]) {
    await expect(started).toContainText("Started. Follow it in the panel.")
    await expect(started).not.toContainText(/5b0f6c1e|9c3e1f2a|ID |Build /)
  }
  await expect(cards.nth(4)).toContainText("Answer it first")
  await expect(cards.nth(5)).toContainText("You said not now.")
  await expect(cards.nth(6)).toContainText("Not started")
  // An error after a yes may still have started the build: the owner checks.
  await expect(cards.nth(7)).toContainText(
    "We could not confirm this went through."
  )
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
  // Nothing to approve while the model is still writing the change.
  await expect(cards.nth(13)).toHaveText("Passing on your change")
  await expect(cards.nth(13).getByRole("button")).toHaveCount(0)
  // A no on its way to the server claims nothing is starting.
  const declining = cards.nth(14)
  await expect(
    declining.getByRole("button", { name: "Approve" })
  ).toBeDisabled()
  await expect(
    declining.getByRole("button", { name: "Not now" })
  ).toBeDisabled()
  await expect(declining.getByRole("button", { name: "Starting" })).toHaveCount(
    0
  )
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
          .withTags(WCAG)
          .analyze()
        expect(
          results.violations.map((violation) => violation.id),
          JSON.stringify(results.violations, null, 2)
        ).toEqual([])
      })
    }
  }
}

test("a message of cards alone has no action bar", async ({ page }) => {
  await open(page, "RequestChange")
  await expect(page.locator(".aui-assistant-action-bar-root")).toHaveCount(0)
})

test("each onboarding step is a message of its own, with its own time", async ({
  page,
}) => {
  await open(page, "Onboarding")
  const steps = page.locator('[data-slot="aui_assistant-message-root"]')
  await expect(steps).toHaveCount(3)
  await expect(steps.locator(".aui-assistant-action-bar-root")).toHaveCount(3)
  await expect(steps.locator("time")).toHaveCount(3)
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveText([
    /Brightclean/,
    /\+447700900123/,
  ])
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
