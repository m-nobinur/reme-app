import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * The Chief of Staff's tools in every state: reads as quiet lines that open
 * onto what they found, and cards that wait for the owner's yes. None shows
 * a tool name, an id, raw output or the api's model-facing error text.
 */

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
  await expect(entry).toContainText("That build is not in your workspace.")
  await expect(entry).not.toContainText("No assignment with that id")
  expect(await entry.innerText()).not.toMatch(WIRE)
})

for (const [entry, slot, yes, busy, target, detail, done, refused] of [
  [
    "AnswerQuestion",
    "answer-question",
    "Send answer",
    "Sending",
    "Weekday hours: 08:00 to 18:00",
    "This answers your build's question: Hourly price for a standard clean.",
    "Sent. Your build carries on.",
    "That question is no longer waiting on you.",
  ],
  [
    "CreateReminder",
    "create-reminder",
    "Add reminder",
    "Adding",
    "Call the window supplier",
    "Due 2 Oct 2026, 09:00 London time. It shows under Reminders.",
    "Added to Reminders. Due 2 Oct 2026, 09:00 London time.",
    "A reminder cannot be due in the past.",
  ],
] as const) {
  test(`${entry} shows every state in the owner's words`, async ({ page }) => {
    await open(page, entry)
    const cards = page.locator(`[data-entry="${entry}"] [data-slot="${slot}"]`)
    await expect(cards).toHaveCount(13)
    // Nothing to approve while the model is still writing it, and a call
    // the stream left unfinished stops rather than working forever.
    await expect(cards.nth(0)).toHaveText("Writing this out")
    await expect(cards.nth(0).getByRole("button")).toHaveCount(0)
    await expect(cards.nth(1)).toContainText("This was not finished.")
    await expect(cards.nth(1).getByRole("button")).toHaveCount(0)
    const asking = cards.nth(2)
    await expect(asking.getByRole("heading")).toHaveText(target)
    await expect(asking).toContainText(detail)
    await expect(asking.getByRole("button", { name: yes })).toBeEnabled()
    await expect(asking.getByRole("button", { name: "Not now" })).toBeEnabled()
    // A target it cannot read gets no yes, only a way to let the step go on.
    await expect(cards.nth(3)).toContainText("did not come through")
    await expect(cards.nth(3).getByRole("button")).toHaveText(["Not now"])
    // Sent and waiting on the server: never optimistic.
    await expect(
      cards.nth(4).getByRole("button", { name: busy })
    ).toBeDisabled()
    await expect(cards.nth(4).locator('[aria-busy="true"]')).toHaveCount(1)
    await expect(cards.nth(5).getByRole("button", { name: yes })).toBeDisabled()
    await expect(cards.nth(5).getByRole("button", { name: busy })).toHaveCount(
      0
    )
    // Held while another card in its step waits.
    await expect(cards.nth(6).getByRole("status")).toHaveText(
      "You said yes. Sent once you answer the other cards."
    )
    await expect(cards.nth(6).getByRole("button")).toHaveCount(0)
    await expect(cards.nth(7)).toContainText(done)
    await expect(cards.nth(8)).toContainText(refused)
    await expect(cards.nth(9)).toContainText("You said not now.")
    await expect(cards.nth(10)).toContainText("You sent a message instead.")
    await expect(cards.nth(11)).toContainText(
      "We could not confirm this went through."
    )
    await expect(cards.nth(12)).toContainText(
      "This did not go through. Ask again."
    )
    const shown = await page.locator(`[data-entry="${entry}"]`).innerText()
    expect(shown).not.toMatch(WIRE)
    // The api's refusal message is never what the owner reads.
    expect(shown).not.toMatch(/No build asked/)
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

test("a reply with words takes a thumb, and says which one is pressed", async ({
  page,
}) => {
  await open(page, "ReplyFeedback")
  const entry = page.locator('[data-entry="ReplyFeedback"]')
  // A reply's thumbs show on hover, and are not there to see until then.
  const replies = entry.locator('[data-slot="aui_assistant-message-root"]')
  const bar = replies.nth(0).locator(".aui-assistant-action-bar-root")
  await expect(bar).toHaveCSS("opacity", "0")
  await replies.nth(0).hover()
  await expect(bar).toHaveCSS("opacity", "1")
  await expect(
    replies.nth(0).getByRole("button", { name: "Helpful", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  const last = replies.nth(1)
  await last.hover()
  await expect(
    last.getByRole("button", { name: "Helpful", exact: true })
  ).toHaveAttribute("aria-pressed", "false")
  await last.getByRole("button", { name: "Not helpful" }).click()
  await expect(
    last.getByRole("button", { name: "Not helpful" })
  ).toHaveAttribute("aria-pressed", "true")
})

test("a reply's thumbs show to the keyboard as well as the pointer", async ({
  page,
}) => {
  await open(page, "ReplyFeedback")
  const reply = page
    .locator(
      '[data-entry="ReplyFeedback"] [data-slot="aui_assistant-message-root"]'
    )
    .first()
  await reply.getByRole("button", { name: "Helpful", exact: true }).focus()
  await expect(reply.locator(".aui-assistant-action-bar-root")).toHaveCSS(
    "opacity",
    "1"
  )
})

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries({
    phone: 390,
    tablet: 768,
    desktop: 1440,
  })) {
    test(`ReplyFeedback has no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, "ReplyFeedback", width, theme)
      const results = await new AxeBuilder({ page })
        .include('[data-entry="ReplyFeedback"]')
        .withTags(WCAG)
        .analyze()
      expect(
        results.violations.map((violation) => violation.id),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([])
    })
  }
}
