import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The workspace shell at the three widths the owner uses it at: a phone in the
 * van, a tablet, and a laptop. The catalog suite scans every entry at one
 * width; the shell changes shape at `md` and `lg`, so it is loaded alone here
 * at each width, in both themes, with each sheet open where there is one.
 */

const WIDTHS = { phone: 390, tablet: 768, desktop: 1440 } as const
const HEIGHT = 900

const railToggle = (page: Page) =>
  page.getByRole("button", { name: "Show menu" })
const sheet = (page: Page) => page.locator('[data-slot="sheet-content"]')
const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" })
/** The panel's header: one line of live activity, and its toggle. */
const panelToggle = (page: Page) => panel(page).getByRole("button").first()

/** Opens a sheet and waits for its entry transition to end before a scan. */
async function openSheet(page: Page, toggle: ReturnType<typeof railToggle>) {
  await toggle.click()
  await expect(sheet(page)).toBeVisible()
  await settle(page)
}

/** Waits for every entry transition to end, so a scan sees final colours. */
async function settle(page: Page) {
  // Only animations that end: the panel's running step pulses for as long as
  // the build runs, and waiting on it would wait forever. A transition cut
  // short rejects and another starts in its place, so this waits until none
  // is left running.
  await page.evaluate(async () => {
    for (;;) {
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations !==
              Number.POSITIVE_INFINITY
        )
      if (running.length === 0) return
      await Promise.all(
        running.map((animation) => animation.finished.catch(() => undefined))
      )
    }
  })
}

/** Every focus stop a keyboard reaches from inside the sheet stays in it. */
async function expectFocusTrapped(page: Page) {
  for (const key of [...Array(12).fill("Tab"), ...Array(4).fill("Shift+Tab")]) {
    await page.keyboard.press(key)
    // Polled: Base UI's trap works through focus guards either side of the
    // popup, which hand focus back on the next tick.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              !!document.activeElement?.closest('[data-slot="sheet-content"]')
          ),
        { message: `focus left the sheet after ${key}`, timeout: 1000 }
      )
      .toBe(true)
  }
}

const cookie = async (page: Page, name: string) =>
  (await page.context().cookies()).find((candidate) => candidate.name === name)
    ?.value

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries(WIDTHS)) {
    test(`the shell has no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, "WorkspaceShell", width, theme)
      await axe(page, `${name} ${theme}`)

      if (width < 768) {
        await openSheet(page, railToggle(page))
        await axe(page, `${name} ${theme} rail sheet`)
        await page.keyboard.press("Escape")
        await expect(sheet(page)).toHaveCount(0)
      }
      if (width < 1024) {
        await panelToggle(page).click()
        await axe(page, `${name} ${theme} panel open`)
      }
    })
  }
}

test("the layout changes shape at md and lg", async ({ page }) => {
  const rail = page.getByRole("complementary", { name: "Workspace" })

  await open(page, "WorkspaceShell", WIDTHS.desktop)
  expect((await rail.boundingBox())?.width).toBe(56)
  expect((await panel(page).boundingBox())?.width).toBe(352)
  await expect(panelToggle(page)).toHaveAttribute("aria-expanded", "true")
  await expect(railToggle(page)).toBeHidden()

  await open(page, "WorkspaceShell", WIDTHS.tablet)
  await expect(rail).toBeVisible()
  await expect(railToggle(page)).toBeHidden()
  // Below lg the panel covers the conversation, so it starts minimised.
  await expect(panelToggle(page)).toHaveAttribute("aria-expanded", "false")

  await open(page, "WorkspaceShell", WIDTHS.phone)
  await expect(rail).toBeHidden()
  await expect(railToggle(page)).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await expect(panelToggle(page)).toHaveAttribute("aria-expanded", "false")
})

test("the bell carries the unread count and opens the newest", async ({
  page,
}) => {
  await open(page, "WorkspaceShell", WIDTHS.phone)
  const bell = page.getByRole("button", { name: "Notifications, 3 unread" })
  await expect(bell).toBeVisible()
  await expect(page.locator('[data-slot="unread-count"]')).toHaveText("3")
  await bell.click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem")).toHaveCount(5)
  await settle(page)
  await expect(
    menu.getByRole("menuitem", { name: "View all notifications" })
  ).toHaveAttribute("href", "#notifications")
  await axe(page, "bell menu")
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(bell).toBeFocused()
})

test("the rail names each icon on hover", async ({ page }) => {
  await open(page, "WorkspaceShell", WIDTHS.desktop)
  await page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("button", { name: "Help" })
    .hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("Help")
})

test("the history lists chats newest first, searchable, a page at a time", async ({
  page,
}) => {
  await open(page, "WorkspaceShell", WIDTHS.desktop)
  await page.getByRole("button", { name: "History" }).click()
  const list = page.getByRole("list", { name: "Conversations" })
  await expect(list.getByRole("link")).toHaveCount(12)
  await expect(list.getByRole("link").first()).toContainText("Weekend prices")
  await expect(list.getByRole("link").first()).toHaveAttribute(
    "aria-current",
    "page"
  )
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(list.getByRole("link")).toHaveCount(24)

  const search = page.getByRole("searchbox", {
    name: "Search your conversations",
  })
  await expect(search).toHaveAttribute(
    "placeholder",
    "Search your conversations…"
  )
  await search.fill("review")
  await expect(list.getByRole("link")).toHaveCount(10)
  await settle(page)
  await axe(page, "history menu")
  await search.fill("nothing like this")
  await expect(
    page.getByText("No conversation has that in its title.")
  ).toBeVisible()

  await search.fill("")
  await list.getByRole("link").nth(1).click()
  await expect(page.locator('[data-slot="history-menu-content"]')).toHaveCount(
    0
  )
})

test("the panel sits under the bell, clear of the page from lg", async ({
  page,
}) => {
  await open(page, "WorkspaceShell", WIDTHS.desktop)
  const bell = await page
    .locator('[data-slot="notification-bell"]')
    .boundingBox()
  const card = await panel(page).boundingBox()
  const page_ = await page.locator('[data-slot="workspace-page"]').boundingBox()
  if (!bell || !card || !page_) throw new Error("not laid out")
  expect(card.y).toBeGreaterThanOrEqual(bell.y + bell.height)
  expect(card.x + card.width).toBeGreaterThanOrEqual(bell.x + bell.width - 1)
  expect(page_.x + page_.width).toBeLessThanOrEqual(card.x)

  // Minimised, the page keeps its column: the card only gets shorter.
  await panelToggle(page).click()
  const after = await page.locator('[data-slot="workspace-page"]').boundingBox()
  expect(after?.width).toBe(page_.width)
})

test("the rail sheet on a phone traps focus and returns it on close", async ({
  page,
}) => {
  await open(page, "WorkspaceShell", WIDTHS.phone)
  await railToggle(page).focus()
  await page.keyboard.press("Enter")
  await expect(sheet(page)).toBeVisible()
  await expectFocusTrapped(page)

  await page.keyboard.press("Escape")
  await expect(sheet(page)).toHaveCount(0)
  await expect(railToggle(page)).toBeFocused()
})

test("a link in a sheet closes it", async ({ page }) => {
  await open(page, "WorkspaceShell", WIDTHS.phone)
  await railToggle(page).click()
  await sheet(page).getByRole("link", { name: "Brightclean" }).click()
  await expect(sheet(page)).toHaveCount(0)
})

test("the rail collapses and remembers it in a cookie", async ({ page }) => {
  await open(page, "WorkspaceShell", WIDTHS.desktop)
  const rail = page.getByRole("complementary", { name: "Workspace" })
  await page.getByRole("button", { name: "Hide sidebar" }).click()
  await expect.poll(async () => (await rail.boundingBox())?.width ?? 0).toBe(0)
  // Inert while collapsed, so nothing in it takes focus.
  await expect(rail).toHaveAttribute("inert", "")
  expect(await cookie(page, "reme-rail")).toBe("closed")

  await page.getByRole("button", { name: "Show sidebar" }).click()
  await expect.poll(async () => (await rail.boundingBox())?.width ?? 0).toBe(56)
  expect(await cookie(page, "reme-rail")).toBe("open")
})

test("the panel minimises to one line and remembers it in a cookie", async ({
  page,
}) => {
  await open(page, "WorkspaceShell", WIDTHS.desktop)
  const toggle = panelToggle(page)
  const body = page.locator(`#${await toggle.getAttribute("aria-controls")}`)
  await expect(body).toBeVisible()

  await toggle.click()
  await expect(body).toBeHidden()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect((await panel(page).boundingBox())?.height).toBeLessThan(60)
  expect(await cookie(page, "reme-panel")).toBe("closed")

  await toggle.click()
  await expect(body).toBeVisible()
  expect(await cookie(page, "reme-panel")).toBe("open")
  // Open, it stops at half the viewport and scrolls past that.
  expect((await panel(page).boundingBox())?.height).toBeLessThanOrEqual(
    HEIGHT / 2 + 48
  )
})

test("an open sheet closes when the viewport grows past its breakpoint", async ({
  page,
}) => {
  await open(page, "WorkspaceShell", WIDTHS.phone)
  await railToggle(page).click()
  await expect(sheet(page)).toBeVisible()
  await page.setViewportSize({ width: WIDTHS.tablet, height: HEIGHT })
  await expect(sheet(page)).toHaveCount(0)
  await expect(
    page.getByRole("complementary", { name: "Workspace" })
  ).toBeVisible()
})

test("a modified click on a link leaves the sheet open", async ({ page }) => {
  await open(page, "WorkspaceShell", WIDTHS.phone)
  await railToggle(page).click()
  // Dispatched rather than clicked: a real modified click opens a new tab,
  // which is the browser's business and not what this asserts.
  await sheet(page)
    .getByRole("link", { name: "Brightclean" })
    .dispatchEvent("click", { button: 0, metaKey: true, bubbles: true })
  await sheet(page)
    .getByRole("link", { name: "Brightclean" })
    .dispatchEvent("click", { button: 1, bubbles: true })
  await expect(sheet(page)).toBeVisible()
})
