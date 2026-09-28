import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

/**
 * The Chief of Staff's tools in every state: reads as quiet lines that open
 * onto what they found, and cards that wait for the owner's yes. None shows
 * a tool name, an id, raw output or the api's model-facing error text.
 */

async function open(page: Page, entry: string, width = 1024, theme = "light") {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/?entry=${entry}&theme=${theme}`)
  await expect(page.locator(`[data-entry="${entry}"]`)).toBeVisible()
}

const WIRE =
  /get_|_question|_reminder|call_|approval_|unknown_outcome|tool_failed|[{}]/

test("reads say what they looked at, and open onto what they found", async ({
  page,
}) => {
  await open(page, "CosReads")
  const entry = page.locator('[data-entry="CosReads"]')
  await expect(
    entry.locator('[data-slot="cos-read-workspace"][role="status"]')
  ).toHaveText("Checking your workspace")
  await expect(entry).toContainText("Could not check your workspace")
  await expect(entry).toContainText("Stopped reading your business details")
  await expect(entry).toContainText("Checked for a preview")

  await entry.getByRole("button", { name: "Checked your workspace" }).click()
  const workspace = entry.locator('[data-slot="cos-read-workspace"] dl')
  await expect(workspace).toContainText("Version 3 is live")
  await expect(workspace).toContainText("Add Saturday hours, 9 to 1.")
  await expect(workspace).toContainText("Building")
  await expect(workspace).toContainText("A question about hourly price")
  await expect(workspace).toContainText("Version 4 to review by")
  await expect(workspace).toContainText("Tagline")

  await entry
    .getByRole("button", { name: "Read your business details" })
    .click()
  await expect(entry.locator('[data-slot="cos-read-facts"] dl')).toContainText(
    "Weekday hours08:00 to 18:00"
  )
  await entry
    .getByRole("button", { name: "Checked the preview of version 4" })
    .click()
  await expect(entry).toContainText("It shows under Your website.")
  await entry.getByRole("button", { name: "Checked for a preview" }).click()
  await expect(entry).toContainText("This build has no preview yet.")
  expect(await entry.innerText()).not.toMatch(WIRE)
})

for (const [entry, slot, yes, busy, target, done, refused] of [
  [
    "AnswerQuestion",
    "answer-question",
    "Send answer",
    "Sending",
    "Weekday hours: 08:00 to 18:00",
    "Sent. Your build carries on.",
    "That question was already answered.",
  ],
  [
    "CreateReminder",
    "create-reminder",
    "Add reminder",
    "Adding",
    "Call the window supplier",
    "Added to Reminders. Due",
    "You have 50 open reminders. Finish one first.",
  ],
] as const) {
  test(`${entry} shows every state in the owner's words`, async ({ page }) => {
    await open(page, entry)
    const cards = page.locator(`[data-entry="${entry}"] [data-slot="${slot}"]`)
    await expect(cards).toHaveCount(10)
    // Nothing to approve while the model is still writing it.
    await expect(cards.nth(0)).toHaveText("Writing this out")
    await expect(cards.nth(0).getByRole("button")).toHaveCount(0)
    const asking = cards.nth(1)
    await expect(asking.getByRole("heading")).toHaveText(target)
    await expect(asking.getByRole("button", { name: yes })).toBeEnabled()
    await expect(asking.getByRole("button", { name: "Not now" })).toBeEnabled()
    // Sent and waiting on the server: never optimistic.
    await expect(
      cards.nth(2).getByRole("button", { name: busy })
    ).toBeDisabled()
    await expect(cards.nth(2).locator('[aria-busy="true"]')).toHaveCount(1)
    // Held while another card in its step waits.
    await expect(cards.nth(3).getByRole("status")).toHaveText(
      "You said yes. Sent once you answer the other cards."
    )
    await expect(cards.nth(3).getByRole("button")).toHaveCount(0)
    await expect(cards.nth(4)).toContainText(done)
    await expect(cards.nth(5)).toContainText(refused)
    await expect(cards.nth(6)).toContainText("You said not now.")
    await expect(cards.nth(7)).toContainText(
      "Not done. You sent a message instead."
    )
    await expect(cards.nth(8)).toContainText(
      "We could not confirm this went through."
    )
    await expect(cards.nth(9)).toContainText(
      "This did not go through. Ask again."
    )
    expect(
      await page.locator(`[data-entry="${entry}"]`).innerText()
    ).not.toMatch(WIRE)
  })
}

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries({
    phone: 390,
    tablet: 768,
    desktop: 1440,
  })) {
    for (const entry of ["CosReads", "AnswerQuestion", "CreateReminder"]) {
      test(`${entry} has no accessibility violations on a ${name} in ${theme}`, async ({
        page,
      }) => {
        await open(page, entry, width, theme)
        if (entry === "CosReads") {
          // Open every read, so its findings are checked too.
          for (const trigger of await page
            .locator(
              '[data-entry="CosReads"] [data-slot="collapsible-trigger"]'
            )
            .all()) {
            await trigger.click()
          }
        }
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
