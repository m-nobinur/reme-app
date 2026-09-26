import { expect, type Page, test } from "@playwright/test"

/**
 * The live panel's behaviour: what each question asks with, what an
 * approval binds to, and that answer, approve and stop all happen in place.
 * The catalog suite scans every entry with axe in both themes, and the shell
 * suite scans the panel at 390, 768 and 1440; this file drives the parts
 * that only show once someone acts.
 */

async function open(page: Page, entry: string, width = 1024) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/?entry=${encodeURIComponent(entry)}`)
  await expect(page.locator(`[data-entry="${entry}"]`)).toBeVisible()
}

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
    item(page, "pricing.standard_clean_hourly").locator('input[type="number"]')
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
