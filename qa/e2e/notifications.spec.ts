import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { AXE_TAGS } from "./axe"
import { visit } from "./visit"

/**
 * The notifications page and the panel's next step, signed in as the
 * session `auth.setup.ts` sealed. That owner has no organisation, so the
 * only next step the panel offers is naming the business, on Home and in a
 * chat, and its notifications are empty. With nothing under way, a page like
 * this one has no panel at all. The other next steps ("Start your website",
 * "Finish setting up" with an onboarding chat) and "Try again" on a
 * panel that did not load need an organisation or a failed read. They are clicked in
 * `packages/ui/test/notifications.spec.ts` against the catalog, and
 * `apps/web/src/panel/workspace-panel.test.ts` checks the destinations the
 * app wires into them. `golden.spec.ts` clicks them live as an owner with
 * an organisation, "Try again" whenever its run reaches it.
 */

// Reduced motion, so axe measures settled colours: the name-your-business page
// carries the sign-in panel, whose greeting pops in.
test.use({ contextOptions: { reducedMotion: "reduce" } })

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
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("button", { name: "Notifications", exact: true })
  await expect(bell).toBeVisible()
  await expect(page.locator('[data-slot="unread-count"]')).toHaveCount(0)
  await bell.click()
  await expect(page.getByText("You are all caught up.")).toBeVisible()
  await page.getByRole("link", { name: "View all notifications" }).click()
  await expect(page).toHaveURL(/\/app\/notifications$/)
})

test("an account with no business is sent to name one", async ({ page }) => {
  // Nothing is under way, so this page has no panel to send it from.
  await visit(page, "/app/notifications")
  await expect(panel(page)).toHaveCount(0)
  await visit(page, "/app")
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
