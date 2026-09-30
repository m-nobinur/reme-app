import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { AXE_TAGS } from "./axe"
import { visit } from "./visit"

/**
 * The notifications page and the panel's blank-state action, signed in as
 * the session `auth.setup.ts` sealed. That owner has no organisation, so
 * the only blank section it can reach is "First steps", whose action is
 * naming the business, and its notifications are empty. The other
 * blank-state actions ("Start your website", "Continue getting
 * started" with an onboarding chat, "Try again" on a panel that did not
 * load) need an organisation or a failed read. They are clicked in
 * `packages/ui/test/notifications.spec.ts` against the catalog, and
 * `apps/web/src/panel/workspace-panel.test.ts` checks the destinations the
 * app wires into them. `golden.spec.ts` clicks them live as an owner with
 * an organisation, "Try again" whenever its run reaches it.
 */

const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" })

test("the notifications page says what will land there", async ({ page }) => {
  await visit(page, "/app/notifications")
  await expect(
    page.getByRole("heading", { name: "Notifications", level: 1 })
  ).toBeVisible()
  await expect(page.getByText("Nothing yet")).toBeVisible()
  await expect(page.locator("li[data-kind]")).toHaveCount(0)
})

test("the bell opens a menu that links to every notification", async ({
  page,
}) => {
  await visit(page, "/app/staff")
  const bell = page
    .getByRole("banner")
    .getByRole("button", { name: "Notifications", exact: true })
  await expect(bell).toBeVisible()
  await expect(page.locator('[data-slot="unread-count"]')).toHaveCount(0)
  await bell.click()
  await expect(page.getByText("You are all caught up.")).toBeVisible()
  await page.getByRole("menuitem", { name: "View all notifications" }).click()
  await expect(page).toHaveURL(/\/app\/notifications$/)
})

test("an account with no business is sent to name one", async ({ page }) => {
  await visit(page, "/app/notifications")
  await panel(page).getByRole("link", { name: "Name your business" }).click()
  await expect(page).toHaveURL(/\/name-your-business$/)
  await expect(
    page.getByRole("heading", { name: "What's your business called?" })
  ).toBeVisible()
  // Not submitted: that would give this account a business, on every
  // environment the smoke runs against, production included.
  await expect(page.getByLabel("Business name")).toBeVisible()
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  expect(
    results.violations.map((violation) => violation.id),
    JSON.stringify(results.violations, null, 2)
  ).toEqual([])
})

test("/app/notifications has no accessibility violations", async ({ page }) => {
  await visit(page, "/app/notifications")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  expect(
    results.violations.map((violation) => violation.id),
    JSON.stringify(results.violations, null, 2)
  ).toEqual([])
})
