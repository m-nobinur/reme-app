import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * The live panel's behaviour: a question points to the chat, an approval
 * binds to its revision, and approve and stop happen in place.
 * The catalog suite scans every entry with axe in both themes, and the shell
 * suite scans the panel at 390, 768 and 1440; this file drives the parts
 * that only show once someone acts.
 */

test("a question in the panel takes no answer, it points to the chat", async ({
  page,
}) => {
  await open(page, "QuestionItem")
  const question = page.locator('[data-slot="question-item"]')
  await expect(question.getByText("Waiting on your answer")).toBeVisible()
  await expect(
    question.getByRole("button", { name: "Answer in the chat" })
  ).toBeVisible()
  await expect(question.locator("input")).toHaveCount(0)
})

test("an approval is named for the site and shows no version or id", async ({
  page,
}) => {
  await open(page, "ApprovalItem", 400)
  const approve = page.getByRole("button", { name: "Publish" })
  await expect(approve).toBeEnabled()
  await expect(page.getByRole("article", { name: "Brightclean" })).toBeVisible()
  await expect(page.getByText(/2f41c9ab|ID |Version \d/)).toHaveCount(0)
  // The front screenshot only: the ones behind are decoration.
  await expect(page.getByRole("img")).toHaveCount(1)
  await expect(page.getByRole("link", { name: /Preview/ })).toHaveAttribute(
    "target",
    "_blank"
  )
})

test("an approval with no revision to publish cannot be approved", async ({
  page,
}) => {
  await open(page, "ApprovalItem unbound", 400)
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled()
})

test("a preview still loading is a skeleton, never a spinner", async ({
  page,
}) => {
  await open(page, "ApprovalItem loading", 400)
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(1)
  await expect(page.getByRole("link")).toHaveCount(0)
})

test("Stop asks once, in place, and offers to keep building", async ({
  page,
}) => {
  await open(page, "StopBuild", 400)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Keep building" })
  ).toBeFocused()
  await expect(
    page.getByRole("button", { name: "Stop this build" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Keep building" }).click()
  await expect(
    page.getByRole("button", { name: "Stop", exact: true })
  ).toBeFocused()
})

test("a segment marks the step at work, and ticks the ones done", async ({
  page,
}) => {
  await open(page, "PanelSegment website photos", 400)
  const segment = page.locator('[data-slot="panel-segment"]')
  await expect(segment.locator('li[data-state="now"]')).toHaveCount(1)
  await expect(segment.locator('li[data-state="now"]')).toContainText(
    "Making 4 photos, 2 done"
  )
  await expect(segment.locator('li[data-state="done"]')).toHaveCount(1)
  await expect(segment.getByText("4 minutes so far")).toBeVisible()
})

test("the screenshots step through the deck, and the approve button shows a focus ring from the keyboard", async ({
  page,
}) => {
  await open(page, "ApprovalItem", 400)
  const approve = page.getByRole("button", { name: "Publish" })
  const front = page.getByRole("img")
  await expect(front).toHaveAccessibleName("Your home page")
  await page.getByRole("button", { name: "The next picture" }).click()
  await expect(front).toHaveAccessibleName("Another page of your website")
  await page.getByRole("button", { name: "The previous picture" }).click()
  await page.getByRole("button", { name: "The previous picture" }).click()
  await expect(front).toHaveAccessibleName("Your home page on a phone")
  await page
    .getByRole("button", { name: "Another page of your website" })
    .click()
  await expect(front).toHaveAccessibleName("Another page of your website")
  await page.getByRole("button", { name: "Your home page on a phone" }).focus()
  await page.keyboard.press("Tab")
  await expect(approve).toBeFocused()
  const ring = await approve.evaluate(
    (node) => getComputedStyle(node).boxShadow
  )
  expect(ring).not.toBe("none")
})

test.describe("with reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } })

  test("the working line's halo does not pulse", async ({ page }) => {
    await open(page, "LiveLine", 400)
    const halo = page.locator('[data-slot="live-line-halo"]')
    expect(
      await halo.evaluate((node) => getComputedStyle(node).animationName)
    ).toBe("none")
  })

  test("the step at work holds still", async ({ page }) => {
    await open(page, "PanelSegment website photos", 400)
    const icon = page.locator('li[data-state="now"] svg').first()
    expect(
      await icon.evaluate((node) => getComputedStyle(node).animationName)
    ).toBe("none")
  })
})

test("a Stop in flight keeps the question up, with its buttons disabled", async ({
  page,
}) => {
  await open(page, "StopBuild stopping", 400)
  await expect(page.getByRole("button", { name: "Stopping" })).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Keep building" })
  ).toBeDisabled()
})

test("the site thumbnail holds its space while it loads, and a broken one leaves the text", async ({
  page,
}) => {
  const entry = (name: string) => page.locator(`[data-entry="${name}"]`)
  await open(page, "YourWebsite", 400)
  await expect(
    entry("YourWebsite").getByRole("img", {
      name: "Your website's home page on a laptop",
    })
  ).toBeVisible()

  await open(page, "YourWebsite loading", 400)
  await expect(
    entry("YourWebsite loading").locator('[data-slot="diffusing"]')
  ).toBeVisible()

  await open(page, "YourWebsite screenshot failed", 400)
  const failed = entry("YourWebsite screenshot failed")
  await expect(failed.getByText("Your website is live")).toBeVisible()
})

test("the site is a link by name, with the host as its title", async ({
  page,
}) => {
  await open(page, "YourWebsite", 400)
  const visit = page.getByRole("link", { name: /Visit your website/ })
  await expect(visit).toHaveAttribute(
    "title",
    "brightclean-demo.example.invalid"
  )
  await expect(visit).toHaveAttribute("target", "_blank")
  await expect(visit).toHaveAttribute("rel", "noreferrer")
  await expect(page.getByText("brightclean-demo.example.invalid")).toHaveCount(
    0
  )
})

test("Request changes sits beside Visit", async ({ page }) => {
  await open(page, "YourWebsite", 400)
  const visit = page.getByRole("link", { name: /Visit your website/ })
  const request = page.getByRole("button", { name: "Request changes" })
  const [a, b] = [await visit.boundingBox(), await request.boundingBox()]
  expect(a?.y).toBe(b?.y)
  expect(a?.height).toBe(b?.height)
  const results = await new AxeBuilder({ page })
    .withTags(WCAG)
    .include('[data-entry="YourWebsite"]')
    .analyze()
  expect(results.violations).toEqual([])

  // Nothing live, nothing to change.
  await open(page, "YourWebsite unpublished", 400)
  await expect(
    page.getByRole("button", { name: "Request changes" })
  ).toHaveCount(0)
})

/** Every state of a written reminder, and the panel's one line. */
const REMINDER_ENTRIES = [
  "ReminderList",
  "ReminderList marked done",
  "ReminderNote",
  "ReminderNote set by the assistant",
  "ReminderNote undated",
  "ReminderNote overdue",
  "ReminderNote pending",
  "ReminderNote failed",
  "LiveLine",
  "LiveLine idle",
]

// The catalog scans these in both themes at one width; this adds the others.
test("reminders have no accessibility violations at any width", async ({
  page,
}) => {
  test.setTimeout(120_000)
  for (const width of [390, 768, 1440]) {
    for (const entry of REMINDER_ENTRIES) {
      await open(page, entry, width)
      const results = await new AxeBuilder({ page })
        .withTags(WCAG)
        .include(`[data-entry="${entry}"]`)
        .analyze()
      expect
        .soft(
          results.violations.map((v) => `${entry} ${width}: ${v.id}`),
          JSON.stringify(results.violations, null, 2)
        )
        .toEqual([])
    }
  }
})

test("each written reminder has its own Done, named for it", async ({
  page,
}) => {
  await open(page, "ReminderList", 400)
  await expect(
    page.getByRole("button", { name: "Done: Send the Hartley Road quote" })
  ).toBeVisible()
  // An asked-for reminder carries no byline.
  await expect(page.getByText("Set by your assistant")).toHaveCount(0)
  await expect(page.getByText("Due Sat 3 Oct, 9:30 AM")).toBeVisible()
  // One due within the hour is marked, and only that one.
  await expect(page.locator('[data-soon="true"]')).toHaveCount(1)
  await expect(page.locator('[data-soon="true"]')).toContainText(
    "Call the supplier about eco sprays"
  )
})

test("a reminder being marked done shows done, and keeps its button", async ({
  page,
}) => {
  await open(page, "ReminderNote pending", 400)
  await expect(page.locator('[data-slot="reminder-note"]')).toHaveAttribute(
    "data-state",
    "done"
  )
  const done = page.getByRole("button", {
    name: "Done: Call the supplier about eco sprays",
  })
  await expect(done).toHaveAttribute("aria-disabled", "true")
})

test("the panel's line stays on one line, however long the name", async ({
  page,
}) => {
  await open(page, "LiveLine truncated", 400)
  const text = page.locator('[data-slot="live-line"] > span').last()
  const { height, lineHeight } = await text.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
  }))
  expect(height).toBeLessThanOrEqual(lineHeight + 1)
  expect(
    await text.evaluate((node) => node.scrollWidth > node.clientWidth)
  ).toBe(true)
})

test("a next step looks like a button, with a visible border", async ({
  page,
}) => {
  for (const theme of ["light", "dark"] as const) {
    await page.goto(`/?entry=NextSteps&theme=${theme}`)
    const link = page.getByRole("link", { name: "Continue getting started" })
    await expect(link).toBeVisible()
    const border = await link.evaluate(
      (el) => getComputedStyle(el).borderTopColor
    )
    // A fully transparent border computes to an alpha of 0.
    expect(border.replace(/\s/g, "").endsWith(",0)"), theme).toBe(false)
  }
})

test("an approval whose preview fails has no accessibility violations at any width", async ({
  page,
}) => {
  const entry = "ApprovalItem preview unavailable"
  for (const width of [390, 768, 1440]) {
    await open(page, entry, width)
    const results = await new AxeBuilder({ page })
      .withTags(WCAG)
      .include(`[data-entry="${entry}"]`)
      .analyze()
    expect
      .soft(
        results.violations.map((v) => `${entry} ${width}: ${v.id}`),
        JSON.stringify(results.violations, null, 2)
      )
      .toEqual([])
  }
})

test("each timeline is a list per day, with the time of day and how far off it is", async ({
  page,
}) => {
  await open(page, "ComingUp timeline", 390)
  const coming = page.getByRole("region", { name: /Coming up/ })
  await expect(coming.getByRole("heading", { level: 3 })).toHaveText([
    "Today",
    "Tomorrow",
    "Sat 31 Oct",
  ])
  const today = coming.getByRole("list", { name: "Today" })
  await expect(today.getByRole("listitem")).toHaveText([
    /10:55 AM\s*Ring Mrs Patel back\s*due now/,
    /11:40 AM\s*Quote for Mrs Patel\s*in 40 min/,
  ])
  await expect(coming.getByRole("list", { name: "Tomorrow" })).toContainText(
    "8:00 AMOrder mop headsin 21 hr"
  )
  // Past due and within the hour are marked; tomorrow's are not.
  await expect(coming.locator("li[data-soon]")).toHaveCount(2)
  await expect(
    today.locator("time").first(),
    "the exact time is the tooltip"
  ).toHaveAttribute("title", "29 Oct 2026, 10:55 AM")
  await expect(today.locator("time").first()).toHaveAttribute(
    "datetime",
    "2026-10-29T10:55:00.000Z"
  )

  const done = page.getByRole("region", { name: /Completed/ })
  await expect(done.getByRole("heading", { level: 3 })).toHaveText([
    "Today",
    "Wed 28 Oct",
  ])
  await expect(done.getByRole("list", { name: "Today" })).toContainText(
    "10:40 AMReminder: call Sam20 min ago"
  )
  await expect(done.locator("li[data-soon]")).toHaveCount(0)
  await expect(page.getByText("View all")).toHaveCount(1)
})

test("a timeline's time column never wraps, at the panel's width or a phone's", async ({
  page,
}) => {
  for (const width of [340, 390]) {
    await open(page, "ComingUp timeline", width)
    for (const time of await page
      .locator('[data-slot="timeline"] time')
      .all()) {
      const label = `${width}: ${await time.textContent()}`
      // One line box for its text, and the text inside its column.
      expect(
        await time.evaluate((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          return (
            range.getClientRects().length === 1 &&
            el.scrollWidth <= el.clientWidth
          )
        }),
        label
      ).toBe(true)
    }
  }
})

test("the timelines have no accessibility violations in either theme", async ({
  page,
}) => {
  const entry = "ComingUp timeline"
  for (const theme of ["light", "dark"]) {
    await open(page, entry, 390, theme)
    const results = await new AxeBuilder({ page })
      .withTags(WCAG)
      .include(`[data-entry="${entry}"]`)
      .analyze()
    expect
      .soft(
        results.violations.map((v) => `${theme}: ${v.id}`),
        JSON.stringify(results.violations, null, 2)
      )
      .toEqual([])
  }
})
