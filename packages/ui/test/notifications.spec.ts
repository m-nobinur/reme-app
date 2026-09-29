import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { open, WCAG } from "./helpers"

/**
 * The notifications list, the rail's unread count, and every blank panel
 * section's next step. The catalog suite scans each entry at one width; the
 * owner reads these on a phone, a tablet and a laptop, so each is scanned
 * alone at all three, in both themes. The blank-state actions are clicked
 * here because the smoke owner, who has no organisation, can only reach the
 * first of them in `qa/e2e`.
 */

const WIDTHS = [390, 768, 1440] as const

const ENTRIES = [
  "NotificationList",
  "NotificationList reports and alerts",
  "NotificationList empty",
  "NotificationList error",
  "NotificationList failed",
  "NavCount",
  "NavCount none",
  "NavCount capped",
  "WaitingOnYou empty",
  "WaitingOnYou error",
  "PanelBlank",
  "PanelBlank ready to build",
  "Reminders empty",
]

for (const theme of ["light", "dark"] as const) {
  test(`notifications and blank states have no accessibility violations in ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    for (const width of WIDTHS) {
      for (const entry of ENTRIES) {
        await open(page, entry, width, theme)
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

test("the list shows one row of each kind the contract has, in its order", async ({
  page,
}) => {
  await open(page, "NotificationList")
  await expect(page.locator("li[data-kind]")).toHaveCount(4)
  expect(
    await page
      .locator("li[data-kind]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")))
  ).toEqual(["question", "approval", "report", "alert"])
  // A question and an approval link to where they are acted on.
  await expect(
    page.getByRole("link", { name: "Answer in the panel" })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Review version 4" })
  ).toBeVisible()
})

test("every alert reason and report has a row", async ({ page }) => {
  await open(page, "NotificationList reports and alerts")
  await expect(page.locator('li[data-kind="report"]')).toHaveCount(1)
  await expect(page.locator('li[data-kind="alert"]')).toHaveCount(3)
})

test("the empty list says what lands there", async ({ page }) => {
  await open(page, "NotificationList empty")
  await expect(page.getByText("Nothing yet")).toBeVisible()
  await open(page, "NotificationList failed")
  await expect(page.getByRole("alert")).toContainText(
    "Notifications did not load"
  )
})

test("the unread count reads as a number and caps at 99+", async ({ page }) => {
  await open(page, "NavCount")
  await expect(page.getByRole("link")).toHaveAccessibleName(
    /^Notifications\s*, 3 unread$/
  )
  await expect(page.locator('[data-slot="nav-count"]')).toHaveText(
    "3, 3 unread"
  )

  await open(page, "NavCount none")
  await expect(
    page.getByRole("link", { name: "Notifications", exact: true })
  ).toBeVisible()
  await expect(page.locator('[data-slot="nav-count"]')).toHaveCount(0)

  await open(page, "NavCount capped")
  await expect(
    page.locator('[data-slot="nav-count"] [aria-hidden="true"]')
  ).toHaveText("99+")
  await expect(page.getByRole("link")).toHaveAccessibleName(/120 unread/)
})

test("the phone's menu toggle carries the unread count", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto("/?entry=WorkspaceShell")
  await expect(
    page.getByRole("button", { name: "Show menu, 3 unread notifications" })
  ).toBeVisible()
  await expect(page.locator('[data-slot="rail-count"]')).toHaveText("3")
})

for (const [entry, name, hash] of [
  ["WaitingOnYou empty", "See notifications", "#notifications"],
  ["PanelBlank", "Continue getting started", "#getting-started"],
  ["PanelBlank ready to build", "Start your website", "#new-chat"],
] as const) {
  test(`${entry} offers "${name}", and it goes there`, async ({ page }) => {
    await open(page, entry)
    await page.getByRole("link", { name }).click()
    expect(new URL(page.url()).hash).toBe(hash)
  })
}

test("Reminders empty offers the add form, and a reminder added clears it", async ({
  page,
}) => {
  await open(page, "Reminders empty")
  await expect(page.getByText("Nothing to remember yet.")).toBeVisible()
  const title = page.getByLabel("Add a reminder")
  await title.fill("Order more microfibre cloths")
  await page.getByRole("button", { name: "Add reminder" }).click()
  await expect(title).toHaveValue("")
})

test("a panel that did not load offers Try again, and it reads again", async ({
  page,
}) => {
  await open(page, "WaitingOnYou error")
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(
    page.getByRole("button", { name: "Trying again" })
  ).toBeDisabled()
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled()
})
