import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * The Chief of Staff's tools in every state: reads as quiet lines, with the
 * reply saying what they found, and cards that wait for the owner's yes. None shows
 * a tool name, an id, raw output or the api's model-facing error text.
 */

const WIRE =
  /get_|_question|_reminder|call_|approval_|unknown_outcome|tool_failed|[{}]/

test("reads say what they looked at, and a finished one shows nothing", async ({
  page,
}) => {
  await open(page, "CosReads")
  const entry = page.locator('[data-entry="CosReads"]')
  await expect(entry.locator('[data-slot="cos-read-workspace"]')).toHaveText([
    "Couldn't check where things stand, try again in a moment",
  ])
  await expect(entry.locator('[data-slot="cos-read-facts"]')).toHaveText([
    "Stopped looking up your details",
  ])
  // A refused preview is finished too; the reply says what came back.
  await expect(entry.locator('[data-slot="cos-read-preview"]')).toHaveCount(0)
  // The reply says what a read found, so nothing opens onto the raw result.
  await expect(
    entry.locator('[data-slot^="cos-read-"]').getByRole("button")
  ).toHaveCount(0)
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
    "This answers your build's question: Service area.",
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
    const everything = page.locator(`[data-entry="${entry}"]`)
    const all = everything.locator(`[data-slot="${slot}"]`)
    await expect(all).toHaveCount(14)
    // A card waiting on the owner sits in the tray, not the thread: the thread
    // keeps the other twelve.
    const cards = all.filter({
      hasNot: page.locator('[data-slot="question-tray"]'),
    })
    await expect(cards).toHaveCount(12)
    // Nothing to approve while the model is still writing it, and a call
    // the stream left unfinished stops rather than working forever.
    await expect(cards.nth(0)).toHaveText(
      entry === "AnswerQuestion"
        ? "Passing on your answer"
        : "Setting a reminder"
    )
    await expect(cards.nth(0).getByRole("button")).toHaveCount(0)
    await expect(cards.nth(1)).toContainText("This was not finished.")
    await expect(cards.nth(1).getByRole("button")).toHaveCount(0)
    // The tray shows one waiting card, the newest, with "1 of 3" to reach the
    // rest: the target it cannot read, then the one asking.
    const shown = everything.locator('[data-slot="question-tray"]:visible')
    await everything.getByRole("button", { name: "Older" }).click()
    // A target it cannot read gets no yes, only a way to let the step go on.
    await expect(shown).toContainText("did not come through")
    await expect(shown.getByRole("button", { name: "Not now" })).toBeEnabled()
    await expect(shown.getByRole("button", { name: yes })).toHaveCount(0)
    await everything.getByRole("button", { name: "Older" }).click()
    await expect(shown.getByRole("heading")).toHaveText(target)
    await expect(shown).toContainText(detail)
    await expect(shown.getByRole("button", { name: yes })).toBeEnabled()
    await expect(shown.getByRole("button", { name: "Not now" })).toBeEnabled()
    // Sent and waiting on the server: never optimistic. The tray is gone and
    // the thread's one line says it is on its way.
    await expect(cards.nth(2)).toContainText(`${busy}…`)
    await expect(cards.nth(2).locator('[aria-busy="true"]')).toHaveCount(1)
    await expect(cards.nth(2).getByRole("button")).toHaveCount(0)
    await expect(cards.nth(3)).toContainText("You said not now.")
    await expect(cards.nth(3).locator('[aria-busy="true"]')).toHaveCount(0)
    await expect(cards.nth(3).getByRole("button")).toHaveCount(0)
    // Held while another card in its step waits.
    await expect(cards.nth(4).getByRole("status")).toHaveText(
      "You said yes. Sent once you answer the other cards."
    )
    await expect(cards.nth(4).getByRole("button")).toHaveCount(0)
    await expect(cards.nth(5)).toContainText(done)
    await expect(cards.nth(6)).toContainText(refused)
    await expect(cards.nth(7)).toContainText("You said not now.")
    await expect(cards.nth(8)).not.toContainText("You sent a message instead.")
    await expect(cards.nth(9)).toContainText(
      "We could not confirm this went through."
    )
    await expect(cards.nth(10)).toContainText(
      "This did not go through. Ask again."
    )
    // A yes that came after the card's time ran out: nothing was done.
    await expect(cards.nth(11)).toContainText(
      "This expired before your yes, so nothing was done."
    )
    await expect(cards.nth(11).getByRole("button")).toHaveCount(0)
    const text = await everything.innerText()
    expect(text).not.toMatch(WIRE)
    // The api's refusal message is never what the owner reads.
    expect(text).not.toMatch(/No build asked/)
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
