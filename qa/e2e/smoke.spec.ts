import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
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

/** The number on one dashboard tile, found by the label above it. */
function statTile(page: Page, label: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('[data-slot="card-title"]')
}

test("the dashboard counts agree with the staff directory", async ({
  page,
}) => {
  await visit(page, "/app")
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true, level: 1 })
  ).toBeVisible()

  const staffCount = Number(await statTile(page, "Staff").innerText())
  const waiting = Number(await statTile(page, "Waiting on you").innerText())
  const pipeline = Number(await statTile(page, "Pipeline").innerText())
  for (const count of [staffCount, waiting, pipeline]) {
    expect(Number.isInteger(count)).toBe(true)
  }
  // This account has no organisation, so every tile is a zero. A number here is
  // either a leak or a fixture, and both are defects.
  expect([staffCount, waiting, pipeline]).toEqual([0, 0, 0])
  await expectNoFixtureContent(page)

  // The invariant, not a copy of the number: the tile says "active", so it has
  // to be the count of people the directory shows as active. Two screens, one
  // server, and a filter that only one of them implements. The directory draws
  // no table at all when it is empty, which is the same answer as zero rows.
  await visit(page, "/app/staff")
  const active = page
    .getByRole("table")
    .getByRole("row")
    .filter({ has: page.getByText("Active", { exact: true }) })
  await expect(active).toHaveCount(staffCount)
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

  // The switcher names the state rather than inventing an organisation, which
  // is the one place on the shell where a fabricated name would look normal.
  await expect(page.getByRole("combobox")).toContainText("No organisation")
})

test("the chat surface replays the recorded conversation", async ({ page }) => {
  await visit(page, "/app/chat")

  await page.getByLabel("Message input").fill("How did this week go?")
  await page.getByLabel("Send message").click()

  // The recording streams reasoning, a tool call, a report and then stops on an
  // approval. The report is what proves text arrived; the approval card is what
  // proves the tool and approval parts render rather than falling through to
  // the raw tool fallback. Both wait longer than the default because the
  // replay carries the inter-chunk delays a live model run would have had.
  await expect(page.getByText("This is a preview of how I report")).toBeVisible(
    { timeout: 30_000 }
  )

  const approval = page.locator('[data-slot="approval-request"]')
  await expect(approval).toBeVisible({ timeout: 30_000 })
  await expect(approval).toContainText("rev_2f41c9")
  await expect(approval.getByRole("button", { name: "Approve" })).toBeVisible()
  await expect(approval.getByRole("button", { name: "Decline" })).toBeVisible()

  // The hole this suite used to have: every other screen was scanned and this
  // one was not, so the recording named `Brightclean` to whoever was signed in
  // for as long as gate 9 was recorded as met. After the stream, because a scan
  // of an empty thread passes without reading anything the replay produced.
  // Narrower than it reads: this test never answers the approval, so it sees
  // the opening turn and not the APPROVED and DENIED branches. Both are clean,
  // checked by hand; a test that answers the approval would cover them.
  await expectNoFixtureContent(page)
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

test("a new owner's dashboard and profile say what comes next", async ({
  page,
}) => {
  // Both read `apps/api` now: attention from the workspace, activity from the
  // event log, facts from the canonical store. A row on any of them for an
  // account with no business is someone else's row.
  await visit(page, "/app")
  const waiting = page.locator("section", {
    has: page.getByRole("heading", { name: "Waiting on you", level: 2 }),
  })
  await expect(waiting.getByText("Nothing waiting on you")).toBeVisible()
  await expect(waiting.locator("article")).toHaveCount(0)
  const activity = page.locator("section", {
    has: page.getByRole("heading", { name: "Recent activity", level: 2 }),
  })
  await expect(activity.getByText("No activity yet")).toBeVisible()
  await expect(activity.getByRole("listitem")).toHaveCount(0)

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
for (const path of ["/app", "/app/staff", "/app/approvals", "/app/pipeline"]) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await visit(page, path)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

    const results = await new AxeBuilder({ page })
      // `best-practice` on top of the WCAG tags, and it is the half that
      // matters here: axe files `heading-order` as best practice rather than as
      // a WCAG failure, so a page whose outline jumps h1 to h3 passes a
      // WCAG-only scan. That is the exact defect that reached this page past a
      // green component catalog. Measured both ways before it was added.
      .withTags([
        "wcag2a",
        "wcag2aa",
        "wcag21a",
        "wcag21aa",
        "wcag22aa",
        "best-practice",
      ])
      .analyze()

    expect(
      results.violations.map((violation) => violation.id),
      JSON.stringify(results.violations, null, 2)
    ).toEqual([])
  })
}
