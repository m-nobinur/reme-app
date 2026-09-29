import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { AXE_TAGS } from "./axe"
import { visit } from "./visit"

/**
 * The notifications page and the panel's blank-state action, signed in as
 * the session `auth.setup.ts` sealed. That owner has no organisation, so
 * the only blank section it can reach is "First steps", whose action is a
 * new chat, and its notifications are empty. The other blank-state actions
 * ("See notifications" beside an empty "Waiting on you", "Continue getting
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

test("the rail links to notifications with nothing unread", async ({
  page,
}) => {
  await visit(page, "/app/approvals")
  const link = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Notifications", exact: true })
  await expect(link).toBeVisible()
  await expect(page.locator('[data-slot="nav-count"]')).toHaveCount(0)
  await link.click()
  await expect(page).toHaveURL(/\/app\/notifications$/)
})

test("the first-steps action opens a new chat", async ({ page }) => {
  await visit(page, "/app/notifications")
  await panel(page).getByRole("link", { name: "Start your website" }).click()
  await expect(page).toHaveURL(/\/app\/?$/)
  await expect(
    page.getByPlaceholder("Ask, or tell me what to change")
  ).toBeVisible()
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
