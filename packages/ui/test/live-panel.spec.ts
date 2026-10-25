import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * The live panel's behaviour: what each question asks with, what an
 * approval binds to, and that answer, approve and stop all happen in place.
 * The catalog suite scans every entry with axe in both themes, and the shell
 * suite scans the panel at 390, 768 and 1440; this file drives the parts
 * that only show once someone acts.
 */

const item = (page: Page, title: string) =>
  page.locator('[data-slot="question-item"]').filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  })

test("each fact is asked with its native input", async ({ page }) => {
  await open(page, "QuestionItem kinds")
  await expect(
    item(page, "hours.weekday").locator('input[type="time"]')
  ).toHaveCount(2)
  await expect(
    item(page, "business.phone").locator('input[type="tel"]')
  ).toHaveCount(1)
  await expect(
    item(page, "business.email").locator('input[type="email"]')
  ).toHaveCount(1)
  await expect(
    item(page, "service_area.radius").locator('input[type="number"]')
  ).toHaveCount(1)
  // Not a fact: text held to the question's own limit, email where it says so.
  await expect(item(page, "Parking").getByLabel("Your answer")).toHaveAttribute(
    "maxlength",
    "80"
  )
  await expect(
    item(page, "Bookings").getByLabel("Your answer")
  ).toHaveAttribute("type", "email")
  // Offered options are a closed choice, not a text box.
  await expect(item(page, "Visit frequency").getByRole("radio")).toHaveCount(3)
  await expect(item(page, "Visit frequency").getByRole("textbox")).toHaveCount(
    0
  )
})

test("a wrong answer is refused in place, with the reason", async ({
  page,
}) => {
  await open(page, "QuestionItem kinds")
  const phone = item(page, "business.phone")
  await phone.getByLabel("Phone number").fill("call me")
  await phone.getByRole("button", { name: "Send answer" }).click()
  await expect(phone.getByRole("alert")).toHaveText(
    "Enter a valid number customers can ring."
  )
  await expect(phone.getByLabel("Phone number")).toHaveAttribute(
    "aria-invalid",
    "true"
  )

  // A UK number as an owner writes it is accepted.
  await phone.getByLabel("Phone number").fill("07700 900123")
  await phone.getByRole("button", { name: "Send answer" }).click()
  await expect(phone.getByRole("alert")).toHaveCount(0)
})

test("closing time cannot be set before opening time", async ({ page }) => {
  await open(page, "QuestionItem")
  await page.getByLabel("Opening time").fill("08:00")
  await expect(page.getByLabel("Closing time")).toHaveAttribute("min", "08:00")
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

test("a done segment is one line with no caret", async ({ page }) => {
  await open(page, "PanelSegment done", 400)
  const segment = page.locator('[data-slot="panel-segment"]')
  await expect(segment).toHaveAttribute("data-state", "folded")
  await expect(segment.locator("button[aria-expanded]")).toHaveCount(0)
})

test("a waiting step offers no link: the answer goes in the chat", async ({
  page,
}) => {
  await open(page, "PanelSegment getting started waiting", 400)
  await expect(page.getByRole("button", { name: "Answer below" })).toHaveCount(
    0
  )
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

test("hours that close before they open are refused in place", async ({
  page,
}) => {
  await open(page, "QuestionItem")
  await page.getByLabel("Opening time").fill("17:00")
  await page.getByLabel("Closing time").fill("08:00")
  await page.getByRole("button", { name: "Send answer" }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "Closing time has to be after opening time."
  )
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

for (const theme of ["light", "dark"] as const) {
  test(`reminders have no accessibility violations in ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    for (const width of [390, 768, 1440]) {
      for (const entry of REMINDER_ENTRIES) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/?entry=${encodeURIComponent(entry)}&theme=${theme}`)
        await expect(page.locator(`[data-entry="${entry}"]`)).toBeVisible()
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
}

test("each written reminder has its own Done, named for it", async ({
  page,
}) => {
  await open(page, "ReminderList", 400)
  await expect(
    page.getByRole("button", { name: "Done: Send the Hartley Road quote" })
  ).toBeVisible()
  await expect(page.getByText("Set by your assistant")).toHaveCount(1)
  await expect(page.getByText("Due Sat 3 Oct, 9:30 am")).toBeVisible()
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
    await page.goto(`/?entry=NextSteps getting started&theme=${theme}`)
    const link = page.getByRole("link", { name: "Continue getting started" })
    await expect(link).toBeVisible()
    const border = await link.evaluate(
      (el) => getComputedStyle(el).borderTopColor
    )
    // A fully transparent border computes to an alpha of 0.
    expect(border.replace(/\s/g, "").endsWith(",0)"), theme).toBe(false)
  }
})

test("an approval whose preview fails still says what the owner can do, and lets them decide", async ({
  page,
}) => {
  await open(page, "ApprovalItem preview unavailable", 400)
  const entry = page.locator('[data-entry="ApprovalItem preview unavailable"]')
  await expect(entry.getByRole("link")).toHaveCount(0)
  await expect(
    entry.getByRole("button", { name: "Retry preview" })
  ).toBeEnabled()
  await expect(entry.getByRole("button", { name: "Publish" })).toBeEnabled()
})

for (const theme of ["light", "dark"] as const) {
  test(`an approval whose preview fails has no accessibility violations in ${theme}`, async ({
    page,
  }) => {
    const entry = "ApprovalItem preview unavailable"
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?entry=${encodeURIComponent(entry)}&theme=${theme}`)
      await expect(page.locator(`[data-entry="${entry}"]`)).toBeVisible()
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
}
