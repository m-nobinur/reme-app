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
  await expect(phone.getByRole("alert")).toHaveText("Check the phone number.")
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

test("an approval shows the version and short id beside Approve", async ({
  page,
}) => {
  await open(page, "ApprovalItem", 400)
  const approve = page.getByRole("button", { name: "Approve and publish v4" })
  await expect(approve).toBeEnabled()
  await expect(page.getByText("Version 4", { exact: true })).toBeVisible()
  await expect(page.getByText("ID 2f41c9ab")).toBeVisible()
  await expect(page.getByRole("img")).toHaveCount(3)
  await expect(
    page.getByRole("link", { name: /Open preview/ })
  ).toHaveAttribute("target", "_blank")
})

test("an approval with no revision to publish cannot be approved", async ({
  page,
}) => {
  await open(page, "ApprovalItem unbound", 400)
  await expect(
    page.getByRole("button", { name: "Approve and publish v4" })
  ).toBeDisabled()
})

test("screenshots load as a skeleton, never a spinner", async ({ page }) => {
  await open(page, "ApprovalItem loading", 400)
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(3)
  await expect(page.getByRole("img")).toHaveCount(0)
})

test("Ask for changes opens a note in place, focused", async ({ page }) => {
  await open(page, "ApprovalItem", 400)
  const ask = page.getByRole("button", { name: "Ask for changes" })
  await ask.click()
  await expect(ask).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByLabel("What should change?")).toBeFocused()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("Stop asks once, in place, and offers to keep building", async ({
  page,
}) => {
  await open(page, "WorkingOn", 400)
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

test("the stepper marks the step the build is on", async ({ page }) => {
  await open(page, "WorkingOn", 400)
  const current = page.locator('[aria-current="step"]')
  await expect(current).toHaveCount(1)
  await expect(current).toHaveText("Building")
  await expect(page.getByText("4 min 10 s so far.")).toBeVisible()
})

test("a ready build offers no Stop", async ({ page }) => {
  await open(page, "WorkingOn states")
  // Every state is placed, and only the ones still building can be stopped.
  await expect(page.locator('[data-slot="working-on"]')).toHaveCount(16)
  await expect(
    page.getByRole("button", { name: "Stop", exact: true })
  ).toHaveCount(9)
})

test("the approve button shows a visible focus ring from the keyboard", async ({
  page,
}) => {
  await open(page, "ApprovalItem", 400)
  const approve = page.getByRole("button", { name: "Approve and publish v4" })
  await page.getByRole("link", { name: /Open preview/ }).focus()
  await page.keyboard.press("Tab")
  await expect(approve).toBeFocused()
  const ring = await approve.evaluate(
    (node) => getComputedStyle(node).boxShadow
  )
  expect(ring).not.toBe("none")
})

test.describe("with reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } })

  test("the working line's dot does not pulse", async ({ page }) => {
    await open(page, "LiveLine", 400)
    const dot = page.locator('[data-slot="live-line"] > span').first()
    expect(
      await dot.evaluate((node) => getComputedStyle(node).animationName)
    ).toBe("none")
  })

  test("the running step does not pulse", async ({ page }) => {
    await open(page, "WorkingOn", 400)
    const bar = page.locator('[aria-current="step"] [data-slot="step-bar"]')
    expect(
      await bar.evaluate((node) => getComputedStyle(node).animationName)
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
  await open(page, "WorkingOn stopping", 400)
  await expect(page.getByRole("button", { name: "Stopping" })).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Keep building" })
  ).toBeDisabled()
})

test("a change in flight keeps its note up", async ({ page }) => {
  await open(page, "ApprovalItem change pending", 400)
  await expect(page.getByLabel("What should change?")).toBeDisabled()
  await expect(page.getByRole("button", { name: "Sending" })).toBeDisabled()
  // Nothing on the page took focus on its own.
  await expect(page.locator("body")).toBeFocused()
})

test("the site thumbnail holds its space, and a broken one leaves the text", async ({
  page,
}) => {
  const entry = (name: string) => page.locator(`[data-entry="${name}"]`)
  await open(page, "YourWebsite", 400)
  await expect(
    entry("YourWebsite").getByRole("img", {
      name: "Your website's home page on a laptop, version 3",
    })
  ).toBeVisible()

  await open(page, "YourWebsite loading", 400)
  await expect(
    entry("YourWebsite loading").locator('[data-slot="skeleton"]')
  ).toBeVisible()

  await open(page, "YourWebsite screenshot failed", 400)
  const failed = entry("YourWebsite screenshot failed")
  await expect(failed.getByRole("img")).toHaveCount(0)
  await expect(failed.getByText("Version 3 is live")).toBeVisible()
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
  "ReminderNote set by Reme",
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
  await expect(page.getByText("Set by Reme")).toHaveCount(1)
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

test("a blank section's next step looks like a button, with a visible border", async ({
  page,
}) => {
  for (const theme of ["light", "dark"] as const) {
    await page.goto(`/?entry=PanelBlank&theme=${theme}`)
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
  let entry = page.locator('[data-entry="ApprovalItem preview unavailable"]')
  await expect(entry).toContainText(
    "The preview for version 4 isn't available yet. Try again in a moment."
  )
  await expect(entry.getByRole("link")).toHaveCount(0)
  await expect(entry.getByRole("button", { name: "Try again" })).toBeEnabled()
  await expect(
    entry.getByRole("button", { name: "Approve and publish v4" })
  ).toBeEnabled()

  await open(page, "ApprovalItem screenshots failed", 400)
  entry = page.locator('[data-entry="ApprovalItem screenshots failed"]')
  await expect(entry).toContainText(
    "The screenshots did not load. Open the preview to see version 4."
  )
  await expect(entry.locator("img")).toHaveCount(0)
  await expect(entry.getByRole("link", { name: /Open preview/ })).toBeVisible()
  await expect(
    entry.getByRole("button", { name: "Approve and publish v4" })
  ).toBeEnabled()
})

for (const theme of ["light", "dark"] as const) {
  test(`an approval whose preview fails has no accessibility violations in ${theme}`, async ({
    page,
  }) => {
    for (const width of [390, 768, 1440]) {
      for (const entry of [
        "ApprovalItem preview unavailable",
        "ApprovalItem screenshots failed",
      ]) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`/?entry=${encodeURIComponent(entry)}&theme=${theme}`)
        const shown = page.locator(`[data-entry="${entry}"]`)
        await expect(shown).toBeVisible()
        if (entry.endsWith("failed")) {
          await expect(shown.locator("img")).toHaveCount(0)
        }
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
