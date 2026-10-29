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
  // The catalogue's wording varies by turn; any of the facts read's lines.
  await expect(entry.locator('[data-slot="cos-read-facts"]')).toHaveText([
    /^Stopped (looking up your details|checking your business details)$/,
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
    "Weekday hours: 8:00 AM to 6:00 PM",
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
    "Due 2 Oct 2026, 9:00 AM London time. It shows under Reminders.",
    "Added to Reminders. Due 2 Oct 2026, 9:00 AM London time.",
    "A reminder cannot be due in the past.",
  ],
] as const) {
  test(`${entry} shows every state in the owner's words`, async ({ page }) => {
    await open(page, entry)
    const everything = page.locator(`[data-entry="${entry}"]`)
    const all = everything.locator(`[data-slot="${slot}"]`)
    // A card the owner talked over folds into the newer one of its kind.
    await expect(all).toHaveCount(13)
    // A card waiting on the owner sits in the tray, not the thread: the thread
    // keeps the other eleven.
    const cards = all.filter({
      hasNot: page.locator('[data-slot="question-tray"]'),
    })
    await expect(cards).toHaveCount(11)
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
    await expect(everything).not.toContainText("You sent a message instead.")
    await expect(everything).toContainText(/1 earlier card: not (added|sent)\./)
    await expect(cards.nth(8)).toContainText(
      "We could not confirm this went through."
    )
    await expect(cards.nth(9)).toContainText(
      "This did not go through. Ask again."
    )
    // A yes that came after the card's time ran out: nothing was done.
    await expect(cards.nth(10)).toContainText(
      "This expired before your yes, so nothing was done."
    )
    await expect(cards.nth(10).getByRole("button")).toHaveCount(0)
    const text = await everything.innerText()
    expect(text).not.toMatch(WIRE)
    // The api's refusal message is never what the owner reads.
    expect(text).not.toMatch(/No build asked/)
  })
}

// The catalog scans each entry as it first renders, in both themes at 1024;
// an opened read is scanned only here, so it keeps both.
for (const [entry, themes] of [
  ["CosReads", ["light", "dark"]],
  ["AnswerQuestion", ["light"]],
  ["CreateReminder", ["light"]],
] as const) {
  for (const theme of themes) {
    for (const [name, width] of Object.entries({
      phone: 390,
      tablet: 768,
      desktop: 1440,
    })) {
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

// The catalog scans it in both themes at 1024.
for (const [name, width] of Object.entries({
  phone: 390,
  tablet: 768,
  desktop: 1440,
})) {
  test(`ReplyFeedback has no accessibility violations on a ${name}`, async ({
    page,
  }) => {
    await open(page, "ReplyFeedback", width)
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

// The catalog's column is narrower than the app's: 336 is where Undo fell to
// a line of its own before, and 360 is the phone the owner saw it on.
for (const width of [336, 360]) {
  test(`a set reminder's Undo stays on the sentence's last line at ${width} px`, async ({
    page,
  }) => {
    await open(page, "CreateReminder", width)
    const card = page
      .locator('[data-entry="CreateReminder"] [data-slot="create-reminder"]')
      .filter({ hasText: "Added to Reminders." })
    const undo = card.getByRole("button", { name: "Undo" })
    await expect(undo).toBeVisible()
    // The words before Undo, line by line: Undo starts after the last line's
    // text, at the same height, rather than alone at the start of a new line.
    const { last, button } = await undo.evaluate((el) => {
      const range = document.createRange()
      range.setStart(el.closest("p") as Node, 0)
      range.setEndBefore(el)
      const lines = [...range.getClientRects()].filter((r) => r.width > 0)
      const end = lines.at(-1) as DOMRect
      const box = el.getBoundingClientRect()
      return {
        last: { right: end.right, middle: end.top + end.height / 2 },
        button: { left: box.left, top: box.top, bottom: box.bottom },
      }
    })
    expect(button.left).toBeGreaterThanOrEqual(last.right - 1)
    expect(last.middle).toBeGreaterThan(button.top)
    expect(last.middle).toBeLessThan(button.bottom)
  })
}
