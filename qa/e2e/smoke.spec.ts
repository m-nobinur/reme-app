import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { visit } from "./visit"

/**
 * The owner smoke path, signed in as the session `auth.setup.ts` sealed.
 *
 * Every screen here reads the golden fixture organisations through the MSW
 * mock (C5), so `brightclean` is what a fresh session sees and the expected
 * shapes below are that organisation's, written out rather than derived. They
 * are the story's own wording: Dana Reyes at the root, Maya beneath her, four
 * siblings under Maya, Priya and Sam under Daniel, Sam paused. A test that
 * recomputes the tree from the same data the page reads agrees with the page
 * whatever either of them does.
 */

type TreeNode = { name: string; badge: string; reports: TreeNode[] }

/** `brightclean`'s reporting lines, as the org tree is required to draw them. */
const EXPECTED_TREE: TreeNode[] = [
  {
    name: "Dana Reyes",
    badge: "Active",
    reports: [
      {
        name: "Maya",
        badge: "Active",
        reports: [
          { name: "Alex", badge: "Active", reports: [] },
          { name: "Nora", badge: "Active", reports: [] },
          { name: "Jamie", badge: "Active", reports: [] },
          {
            name: "Daniel",
            badge: "Active",
            reports: [
              { name: "Priya", badge: "Active", reports: [] },
              { name: "Sam", badge: "Paused", reports: [] },
            ],
          },
        ],
      },
    ],
  },
]

/**
 * The rendered tree as data.
 *
 * Read structurally rather than as text, because the failure this exists to
 * catch is a correct set of names hung off the wrong parents, and every
 * text-level assertion passes on that.
 */
function readTree(page: Page): Promise<TreeNode[]> {
  return page
    .locator('ul[aria-label="Reporting lines"]')
    .evaluate((root: Element) => {
      const read = (list: Element): TreeNode[] =>
        [...list.children]
          .filter((child) => child.tagName === "LI")
          .map((item) => {
            const card = item.querySelector(":scope > div")
            const nested = item.querySelector(":scope > ul")
            return {
              name: card?.querySelector(":scope > span")?.textContent ?? "",
              badge:
                card?.querySelector('[data-slot="badge"]')?.textContent ?? "",
              reports: nested ? read(nested) : [],
            }
          })
      return read(root)
    })
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

  // The invariant, not a copy of the number: the tile says "active", so it has
  // to be the count of people the directory shows as active. Two screens, one
  // server, and a filter that only one of them implements.
  await visit(page, "/app/staff")
  const active = page
    .getByRole("table")
    .getByRole("row")
    .filter({ has: page.getByText("Active", { exact: true }) })
  await expect(active).toHaveCount(staffCount)
  expect(staffCount).toBeGreaterThan(0)
})

test("the org tree draws the reporting lines", async ({ page }) => {
  await visit(page, "/app/staff")
  await expect(
    page.getByRole("heading", { name: "Reporting lines" })
  ).toBeVisible()
  expect(await readTree(page)).toEqual(EXPECTED_TREE)
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
  await expect(page.getByText("Here is the week for")).toBeVisible({
    timeout: 30_000,
  })

  const approval = page.locator('[data-slot="approval-request"]')
  await expect(approval).toBeVisible({ timeout: 30_000 })
  await expect(approval).toContainText("rev_2f41c9")
  await expect(approval.getByRole("button", { name: "Approve" })).toBeVisible()
  await expect(approval.getByRole("button", { name: "Decline" })).toBeVisible()
})

test("the approvals inbox lists decisions with both answers in reach", async ({
  page,
}) => {
  await visit(page, "/app/approvals")
  // Level 1 and exact, because the page also carries a screen-reader-only h2
  // "Approvals waiting on you" and Playwright matches accessible names by
  // substring unless told otherwise: without both options this locator resolves
  // to two headings and never settles.
  await expect(
    page.getByRole("heading", { name: "Approvals", exact: true, level: 1 })
  ).toBeVisible()

  const cards = page.getByRole("listitem").filter({ hasText: "Approve" })
  await expect(cards.first()).toBeVisible()
  const waiting = await cards.count()
  expect(waiting).toBeGreaterThan(0)

  // One tap each, neither behind a menu: the §7.3 shape the card exists for.
  await expect(
    cards.first().getByRole("button", { name: "Approve" })
  ).toBeVisible()
  await expect(
    cards.first().getByRole("button", { name: "Decline" })
  ).toBeVisible()

  // The filter is the one interactive thing on this page that changes what is
  // listed, and an empty result has to say so rather than render nothing.
  await page.getByLabel("Filter approvals").fill("zzz-no-such-approval")
  await expect(page.getByText("No matches")).toBeVisible()
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
