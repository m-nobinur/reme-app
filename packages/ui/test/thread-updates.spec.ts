import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * What is new in a conversation, and what the app posted by itself: a "New"
 * rule above the first message this browser had not shown, which stays put
 * while the conversation is open and is gone on the next visit, and an
 * "Update" label, with its kind's icon and time, on each posted message.
 */

const ENTRY = "ThreadNewSince"

test.use({ timezoneId: "Europe/London" })

const root = (page: Page) => page.locator(`[data-entry="${ENTRY}"]`)
const rule = (page: Page) => root(page).locator('[data-slot="aui_new-divider"]')
const replies = (page: Page) =>
  root(page).locator('[data-slot="aui_assistant-message-root"]')

test("the New rule sits above the first message not shown here, and stays while open", async ({
  page,
}) => {
  await open(page, ENTRY)
  await expect(rule(page)).toHaveCount(1)
  await expect(rule(page)).toHaveText("New messages")
  // The next row after the rule is the site going live.
  await expect(
    rule(page).locator(
      'xpath=following-sibling::*[@data-slot="aui_assistant-message-root"][1]'
    )
  ).toContainText("Your website is live")
  // Showing the thread moved the mark to its end (an effect, run by now);
  // the next visit has nothing new.
  await root(page).getByRole("button", { name: "Open again" }).click()
  await expect(replies(page)).toHaveCount(3)
  await expect(rule(page)).toHaveCount(0)
})

test("a posted message carries Update, its kind and its time; a reply does not", async ({
  page,
}) => {
  await open(page, ENTRY)
  const labels = root(page).locator('[data-slot="aui_update-label"]')
  // On the device's clock: London in September is an hour ahead of UTC.
  await expect(labels).toHaveText(["Update·3:14 PM", "Update·4:00 PM"])
  await expect(
    replies(page).nth(0).locator("[data-slot=aui_update-label]")
  ).toHaveCount(0)
  // Each says its time once: a reply in its footer, an update in its label.
  for (const n of [0, 1, 2]) {
    await expect(replies(page).nth(n).locator("time")).toHaveCount(1)
  }
  await expect(
    replies(page)
      .nth(1)
      .locator("[data-slot=aui_assistant-message-footer] time")
  ).toHaveCount(0)
  // The live site's globe, and the bell for a post with no kind.
  const [globe, bell] = await Promise.all(
    [0, 1].map((n) => labels.nth(n).locator("svg").innerHTML())
  )
  expect(globe).not.toBe(bell)
  // Only the newest update is in the primary colour, its icon ringing.
  await expect(labels.nth(0).locator("svg")).not.toHaveClass(
    /animate-update-ring/
  )
  await expect(labels.nth(1).locator("svg")).toHaveClass(/animate-update-ring/)
  await expect(labels.nth(1).getByText("Update")).toHaveClass(/text-primary/)
  await expect(labels.nth(0).getByText("Update")).not.toHaveClass(
    /text-primary/
  )
  // Its words are a normal reply, with its button under them.
  await expect(replies(page).nth(1)).toContainText(
    "Your website is live at sparkle-clean.co.uk."
  )
  await expect(
    replies(page)
      .nth(1)
      .getByRole("link", { name: /View site/ })
  ).toBeVisible()
})

test("the rule and the labels have no accessibility violations in either theme", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await open(page, ENTRY, 390, theme)
    const results = await new AxeBuilder({ page })
      .withTags(WCAG)
      .include(`[data-entry="${ENTRY}"]`)
      .analyze()
    expect
      .soft(
        results.violations.map((v) => `${theme}: ${v.id}`),
        JSON.stringify(results.violations, null, 2)
      )
      .toEqual([])
  }
})
