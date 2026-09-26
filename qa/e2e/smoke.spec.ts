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

/** The panel beside the conversation, by its landmark name. */
function panel(page: Page) {
  return page.getByRole("complementary", { name: "Panel" })
}

test("the panel shows a new owner their first steps and nothing else", async ({
  page,
}) => {
  await visit(page, "/app")
  // This account has no organisation, so a question, an approval or a build
  // here is either a leak or a fixture, and both are defects.
  await expect(
    panel(page).getByRole("heading", { name: "First steps", level: 2 })
  ).toBeVisible()
  await expect(panel(page).getByRole("listitem")).toHaveText([
    "To do: Build your first version",
  ])
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
  // The server reads the cookie, so the HTML already carries the answer: an
  // open panel is `lg:flex`, a closed one is not. Read from the response, not
  // the page, because after hydration the client could have fixed a wrong
  // first paint and this would pass on the shift it exists to prevent.
  //
  // The conversation routes too: the chat itself is client only, and the
  // frame and panel around it are still the server's.
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
  for (const path of [
    "/app/approvals",
    "/app",
    "/app/c/00000000-0000-4000-8000-000000000000",
  ]) {
    const closed = await panelClass(path, "closed")
    expect(closed, `no panel in the server HTML of ${path}`).toContain(
      "workspace-panel"
    )
    expect(closed).not.toContain("lg:flex")
    expect(await panelClass(path, "open"), path).toContain("lg:flex")
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

  // The switcher names the state rather than inventing an organisation, which
  // is the one place on the shell where a fabricated name would look normal.
  await expect(page.getByRole("combobox")).toContainText("No organisation")
})

test("the old chat address lands on the conversation", async ({ page }) => {
  await visit(page, "/app/chat")
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByLabel("Message input")).toBeVisible()
})

test("a chat turn sends only what the owner did", async ({ page }) => {
  await visit(page, "/app")

  // Server function calls after the send: the frame read the router makes
  // again once the turn ends, so the panel and its count are not stale.
  const reads: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/_serverFn/")) {
      reads.push(request.url())
    }
  })
  const sent = page.waitForRequest((request) =>
    request.url().endsWith("/api/chat")
  )

  await page.getByLabel("Message input").fill("How did this week go?")
  await page.getByLabel("Send message").click()

  // The turn and nothing else: no history, system prompt or tools leave the
  // browser, because the server reads its own rows.
  const body = (await sent).postDataJSON()
  expect(Object.keys(body).sort()).toEqual(["conversation_id", "mode", "turn"])
  expect(body.turn).toMatchObject({
    kind: "message",
    text: "How did this week go?",
  })

  // The probe owner has no organisation, so apps/api refuses the turn. It
  // reads as the api's own sentence, not as the JSON it came in, and it
  // writes nothing anywhere.
  const refusal = page.locator(".aui-message-error-message")
  await expect(refusal).toHaveText(/organisation/)
  await expect(refusal).not.toContainText("{")
  await expect
    .poll(() => reads.length, {
      message: "the frame was not read again after the turn",
    })
    .toBeGreaterThan(0)
  await expectNoFixtureContent(page)
})

test("New chat starts an empty conversation", async ({ page }) => {
  await visit(page, "/app")
  await page.getByLabel("Message input").fill("How did this week go?")
  await page.getByLabel("Send message").click()
  await expect(page.getByText("How did this week go?")).toBeVisible()

  await page.getByRole("link", { name: "New chat" }).click()
  await expect(
    page.getByRole("heading", { name: "What should we do today?" })
  ).toBeVisible()
  await expect(page.getByText("How did this week go?")).toHaveCount(0)
})

test("every chat request carries the mode, and a new chat keeps it", async ({
  page,
}) => {
  await visit(page, "/app")
  const sent = () =>
    page
      .waitForRequest((request) => request.url().endsWith("/api/chat"))
      .then((request) => request.postDataJSON()?.mode)

  let mode = sent()
  await page.getByLabel("Message input").fill("How did this week go?")
  await page.getByLabel("Send message").click()
  expect(await mode).toBe("act")

  await page.getByRole("button", { name: "Mode, Act" }).click()
  await page.getByRole("menuitemradio", { name: /^Ask/ }).click()
  await page.getByRole("link", { name: "New chat" }).click()
  await expect(page.getByRole("button", { name: "Mode, Ask" })).toBeVisible()

  mode = sent()
  await page.getByLabel("Message input").fill("What is waiting on me?")
  await page.getByLabel("Send message").click()
  expect(await mode).toBe("ask")
})

test("the top bar names a new chat and a stored one truthfully", async ({
  page,
}) => {
  const title = page.locator('[data-slot="workspace-title"]')
  await visit(page, "/app")
  await expect(title).toHaveText("New chat")
  // An address with an id is a stored conversation, so it is not "new".
  await visit(page, "/app/c/any-conversation")
  await expect(title).toHaveText("Conversation")
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
  await page.locator("main").evaluate((main) => {
    const spacer = document.createElement("div")
    spacer.style.height = "4000px"
    main.append(spacer)
    main.scrollTop = 1200
  })
  await page.waitForTimeout(300)

  await page.getByRole("link", { name: "Pipeline" }).click()
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
