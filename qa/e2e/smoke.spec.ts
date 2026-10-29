import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { AXE_TAGS } from "./axe"
import { visit } from "./visit"

/**
 * The owner smoke path, signed in as the session `auth.setup.ts` sealed.
 *
 * Every screen here reads `apps/api` under that session. It used to read the
 * golden fixtures through a mock, and the assertions were `brightclean`'s
 * reporting lines: Dana Reyes at the root, Maya beneath her. That is the whole
 * point of what changed. The suite's account is created for the run and belongs
 * to no organisation, so what it must see now is the empty state on every
 * screen and no trace of anyone else's business.
 *
 * The empty case is not a weaker test than the fixture one, it is a different
 * one. A page showing a business the signed-in person has nothing to do with
 * looks identical to a cross-tenant leak, and these are the assertions that
 * fail on it.
 */

/**
 * Names that were on these screens yesterday and must not be on them under a
 * real session. Fictional fixture businesses, so nothing here is a secret; the
 * value is that each one is a string only the mock could produce.
 *
 * The hostname is on the list because the chat recording used to publish to
 * `brightclean.mypareme.app`, and a tenant hostname naming someone else's
 * business is the same defect as their staff directory.
 */
const FIXTURE_CONTENT = [
  "Brightclean",
  "Mop & Bucket",
  "Dana Reyes",
  // Not "Maya": every new org's Chief of Staff carries that name, so it no
  // longer marks someone else's business. The other golden owner does.
  "Kit Mbeki",
  "brightclean.mypareme.app",
]

async function expectNoFixtureContent(page: Page) {
  // Folded, so a screen that title-cases or lowercases one of these still
  // fails. `toContain` is case-sensitive and the list already carries one name
  // twice because of it.
  const body = (await page.locator("body").innerText()).toLowerCase()
  for (const name of FIXTURE_CONTENT) {
    expect(
      body,
      `${name} reached a session that has no claim on it`
    ).not.toContain(name.toLowerCase())
  }
}

/** The panel beside the conversation, by its landmark name. */
function panel(page: Page) {
  return page.getByRole("complementary", { name: "Panel" })
}

test("the panel asks a new owner to name the business and nothing else", async ({
  page,
}) => {
  await visit(page, "/app")
  // This account has no organisation, so a question, an approval or a build
  // here is either a leak or a fixture, and both are defects. With no
  // business there are no steps to list yet: naming it comes first.
  await expect(panel(page).getByRole("listitem")).toHaveText([
    "Name your business",
  ])
  await expect(
    panel(page)
      .getByRole("list", { name: "Next steps" })
      .getByRole("link", { name: "Name your business" })
  ).toBeVisible()
  await expect(
    panel(page).getByRole("heading", { name: "First steps" })
  ).toHaveCount(0)
  await expect(
    panel(page).getByRole("heading", { name: "Waiting on you" })
  ).toHaveCount(0)
  await expect(
    panel(page).getByRole("heading", { name: "Working on" })
  ).toHaveCount(0)
  await expectNoFixtureContent(page)
})

test("the panel is where the owner left it on the first paint", async ({
  page,
}) => {
  // The server reads the cookie, so the HTML already carries the answer in
  // the panel's `data-state`. Read from the response, not
  // the page, because after hydration the client could have fixed a wrong
  // first paint and this would pass on the shift it exists to prevent.
  //
  // The conversation routes too: the chat itself is client only, and the
  // frame and panel around it are still the server's. Only pages where this
  // account's panel has something to say: it has no business, so Approvals
  // has no panel at all, and the server sends none.
  const panelClass = async (path: string, state: string) => {
    await page.context().addCookies([
      {
        name: "reme-panel",
        value: state,
        url: test.info().project.use.baseURL ?? "",
      },
    ])
    const response = await page.request.get(path)
    expect(response.status(), path).toBe(200)
    const html = await response.text()
    return /<aside[^>]*id="workspace-panel"[^>]*>/.exec(html)?.[0] ?? ""
  }
  expect(await panelClass("/app/approvals", "open")).toBe("")
  // With no business the panel opens on its one next step, whatever the
  // cookie says, so both states arrive open in the server's HTML.
  for (const path of ["/app", "/app/c/00000000-0000-4000-8000-000000000000"]) {
    for (const state of ["closed", "open"]) {
      const html = await panelClass(path, state)
      expect(html, `no panel in the server HTML of ${path}`).toContain(
        "workspace-panel"
      )
      expect(html, `${path} with ${state}`).toContain('data-state="open"')
    }
  }
})

test("the staff directory tells a new owner it is empty", async ({ page }) => {
  await visit(page, "/app/staff")
  await expect(
    page.getByRole("heading", { name: "Staff", exact: true, level: 1 })
  ).toBeVisible()

  // The empty state, and it has to be visible rather than merely present: a
  // page that rendered nothing at all would satisfy every absence below.
  await expect(page.getByText("No staff yet")).toBeVisible()
  await expect(page.getByRole("table")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Reporting lines" })
  ).toHaveCount(0)
  await expectNoFixtureContent(page)

  // Settings name the state rather than inventing an organisation, the one
  // place on the shell where a fabricated name would look normal.
  await page.locator('[data-slot="profile-menu"]').click()
  await expect(
    page.getByRole("dialog", { name: "Settings" }).getByText("No organisation")
  ).toBeVisible()
})

test("with no business, /app asks for its name and offers no chat", async ({
  page,
}) => {
  // The probe owner has no organisation, so the new-chat address is the
  // naming form: an assistant with no business has nothing to talk about.
  // Not submitted, so the probe stays without one.
  await visit(page, "/app")
  await expect(page).toHaveURL(/\/app$/)
  await expect(
    page.getByRole("heading", { name: "What's your business called?" })
  ).toBeVisible()
  await expect(page.getByLabel("Business name")).toBeVisible()
  await expect(page.getByLabel("Message input")).toHaveCount(0)

  // New conversation lands on the same form.
  await page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("link", { name: "New conversation" })
    .click()
  await expect(page.getByLabel("Business name")).toBeVisible()
  await expect(page.getByLabel("Message input")).toHaveCount(0)
  await expectNoFixtureContent(page)
})

test("the rail holds a new conversation and the bell", async ({ page }) => {
  await visit(page, "/app/staff")
  const rail = page.getByRole("complementary", { name: "Workspace" })
  await expect(
    rail.getByRole("link", { name: "New conversation" })
  ).toBeVisible()
  await expect(
    rail.getByRole("button", { name: "Notifications", exact: true })
  ).toBeVisible()
  // No conversation yet, so Chat says so instead of opening the history.
  await expect(rail.getByRole("button", { name: "Chat" })).toBeDisabled()
})

test("the settings switch the theme", async ({ page }) => {
  await visit(page, "/app/staff")
  const dark = () =>
    page.evaluate(() => document.documentElement.classList.contains("dark"))
  const before = await dark()
  await page.locator('[data-slot="profile-menu"]').click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings
    .getByRole("button", { name: before ? "Light theme" : "Dark theme" })
    .click()
  await expect.poll(dark).toBe(!before)
  // It stays open and names the way back.
  await expect(
    settings.getByRole("button", {
      name: before ? "Dark theme" : "Light theme",
    })
  ).toBeVisible()
})

test("Ask for help asks for the business first when there is none", async ({
  page,
}) => {
  await visit(page, "/app/staff")
  await page.locator('[data-slot="profile-menu"]').click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("button", { name: "Help & support" }).click()
  // An owner with no organisation has nothing to get started on.
  await expect(
    settings.getByRole("link", { name: "Getting started" })
  ).toHaveCount(0)
  await settings.getByRole("link", { name: "Ask for help" }).click()
  // No business to talk about yet, so naming it comes first.
  await expect(page.getByLabel("Business name")).toBeVisible()
  await expect(page.getByLabel("Message input")).toHaveCount(0)
})

test("a conversation the owner has none under says so", async ({ page }) => {
  await visit(page, "/app/c/any-conversation")
  // An id the owner has no conversation under says so, rather than opening
  // a thread nobody asked for.
  await expect(page.getByText("This conversation is not here")).toBeVisible()
})

test("each page opens at the top, and Back returns to where the owner was", async ({
  page,
}) => {
  const top = () => page.locator("main").evaluate((main) => main.scrollTop)
  await visit(page, "/app/staff")
  // An account with no business has no page tall enough to scroll, so main is
  // given the height. The node sits outside React's tree and survives the
  // navigation, which is what lets the reset be seen.
  // The router records a position from its capturing scroll listener on the
  // document, added before this one, so this one firing means it is recorded.
  await page.locator("main").evaluate(
    (main) =>
      new Promise<void>((recorded) => {
        const spacer = document.createElement("div")
        spacer.style.height = "4000px"
        main.append(spacer)
        document.addEventListener("scroll", () => recorded(), {
          capture: true,
          once: true,
        })
        main.scrollTop = 1200
      })
  )

  await page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("link", { name: "Pipeline" })
    .click()
  await expect(page).toHaveURL(/\/app\/pipeline/)
  await expect.poll(top).toBe(0)

  await page.goBack()
  await expect(page).toHaveURL(/\/app\/staff/)
  await expect.poll(top).toBe(1200)
})

test("the approvals inbox has nothing to decide", async ({ page }) => {
  await visit(page, "/app/approvals")
  // Level 1 and exact, because the page also carries a screen-reader-only h2
  // "Approvals waiting on you" and Playwright matches accessible names by
  // substring unless told otherwise: without both options this locator resolves
  // to two headings and never settles.
  await expect(
    page.getByRole("heading", { name: "Approvals", exact: true, level: 1 })
  ).toBeVisible()

  // The approvals come from this owner's workspace, and an owner with no
  // business has none. An approval card here would be a decision this owner was
  // never asked for, which is the §7.3 failure worth failing on.
  await expect(page.getByText("Nothing waiting on you")).toBeVisible()
  await expect(
    page.getByRole("listitem").filter({ hasText: "Approve" })
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0)
  await expectNoFixtureContent(page)
})

test("an owner with no business yet sees empty states and no one else's rows", async ({
  page,
}) => {
  // The suite's owner belongs to no org, so this screen returns before it
  // reads `apps/api`. The reads themselves are covered by client.test.ts and by
  // the owner workspace exit run; an owner with an org arrives with the golden
  // path, which can clean up the tenant rows it writes.
  await visit(page, "/app/profile")
  await expect(page.getByText("Nothing recorded yet")).toBeVisible()
  await expect(page.locator('[data-slot="card"]')).toHaveCount(0)
  await expectNoFixtureContent(page)
})

/**
 * The page-grain accessibility check.
 *
 * The component catalog scans each primitive in isolation, which cannot see a
 * heading level that is right beside one page's h2 and wrong on a page with
 * none: exactly that defect reached `/app/approvals` past a green catalog. This
 * runs the same WCAG 2.2 AA rule set against the assembled page under a real
 * session, which is the only place it is visible.
 */
for (const path of [
  "/app",
  "/app/staff",
  "/app/approvals",
  "/app/pipeline",
  "/app/profile",
]) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await visit(page, path)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()

    expect(
      results.violations.map((violation) => violation.id),
      JSON.stringify(results.violations, null, 2)
    ).toEqual([])
  })
}
