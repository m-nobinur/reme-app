import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

/**
 * The workspace shell at the three widths the owner uses it at: a phone in the
 * van, a tablet, and a laptop. The catalog suite scans every entry at one
 * width; the shell changes shape at `md` and `lg`, so it is loaded alone here
 * at each width, in both themes, with each sheet open where there is one.
 */

const WIDTHS = { phone: 390, tablet: 768, desktop: 1440 } as const
const HEIGHT = 900

async function open(page: Page, width: number, theme = "light") {
  await page.setViewportSize({ width, height: HEIGHT })
  await page.goto(`/?entry=WorkspaceShell&theme=${theme}`)
  await expect(page.locator('[data-slot="workspace-shell"]')).toBeVisible()
}

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze()
  expect
    .soft(
      results.violations.map((violation) => `${label}: ${violation.id}`),
      JSON.stringify(results.violations, null, 2)
    )
    .toEqual([])
}

const railToggle = (page: Page) =>
  page.getByRole("button", { name: "Show menu" })
const panelSheetToggle = (page: Page) =>
  page.getByRole("button", { name: /^Show panel, 2 waiting on you$/ })
const sheet = (page: Page) => page.locator('[data-slot="sheet-content"]')

/** Opens a sheet and waits for its entry transition to end before a scan. */
async function openSheet(page: Page, toggle: ReturnType<typeof railToggle>) {
  await toggle.click()
  await expect(sheet(page)).toBeVisible()
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished))
  )
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

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries(WIDTHS)) {
    test(`the shell has no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, width, theme)
      await axe(page, `${name} ${theme}`)

      if (width < 768) {
        await openSheet(page, railToggle(page))
        await axe(page, `${name} ${theme} rail sheet`)
        await page.keyboard.press("Escape")
        await expect(sheet(page)).toHaveCount(0)
      }
      if (width < 1024) {
        await openSheet(page, panelSheetToggle(page))
        await axe(page, `${name} ${theme} panel sheet`)
      }
    })
  }
}

test("the layout changes shape at md and lg", async ({ page }) => {
  const rail = page.getByRole("complementary", { name: "Workspace" })
  const panel = page.getByRole("complementary", { name: "Panel" })

  await open(page, WIDTHS.desktop)
  expect((await rail.boundingBox())?.width).toBe(240)
  expect((await panel.boundingBox())?.width).toBe(320)
  await expect(railToggle(page)).toBeHidden()
  await expect(panelSheetToggle(page)).toBeHidden()

  await open(page, WIDTHS.tablet)
  await expect(rail).toBeVisible()
  await expect(panel).toBeHidden()
  await expect(railToggle(page)).toBeHidden()
  await expect(panelSheetToggle(page)).toBeVisible()

  await open(page, WIDTHS.phone)
  await expect(rail).toBeHidden()
  await expect(panel).toBeHidden()
  await expect(railToggle(page)).toBeVisible()
  // The count is in the accessible name, and drawn on the toggle.
  await expect(
    panelSheetToggle(page).locator('[data-slot="panel-count"]')
  ).toHaveText("2")
})

for (const [label, width, toggle] of [
  ["the rail sheet on a phone", WIDTHS.phone, railToggle],
  ["the panel sheet on a phone", WIDTHS.phone, panelSheetToggle],
  ["the panel sheet on a tablet", WIDTHS.tablet, panelSheetToggle],
] as const) {
  test(`${label} traps focus and returns it on close`, async ({ page }) => {
    await open(page, width)
    await toggle(page).focus()
    await page.keyboard.press("Enter")
    await expect(sheet(page)).toBeVisible()
    await expectFocusTrapped(page)

    await page.keyboard.press("Escape")
    await expect(sheet(page)).toHaveCount(0)
    await expect(toggle(page)).toBeFocused()
  })
}

test("a link in a sheet closes it", async ({ page }) => {
  await open(page, WIDTHS.phone)
  await railToggle(page).click()
  await sheet(page).getByRole("link", { name: "Staff" }).click()
  await expect(sheet(page)).toHaveCount(0)
})

test("the panel toggle hides the panel and remembers it in a cookie", async ({
  page,
}) => {
  await open(page, WIDTHS.desktop)
  const panel = page.getByRole("complementary", { name: "Panel" })
  const cookie = async () =>
    (await page.context().cookies()).find(
      (candidate) => candidate.name === "reme-panel"
    )?.value

  await page.getByRole("button", { name: "Hide panel" }).click()
  await expect(panel).toBeHidden()
  await expect(
    page.getByRole("button", { name: "Show panel", exact: true })
  ).toHaveAttribute("aria-expanded", "false")
  expect(await cookie()).toBe("closed")

  await page.getByRole("button", { name: "Show panel", exact: true }).click()
  await expect(panel).toBeVisible()
  expect(await cookie()).toBe("open")
})

test("an open sheet closes when the viewport grows past its breakpoint", async ({
  page,
}) => {
  await open(page, WIDTHS.tablet)
  await panelSheetToggle(page).click()
  await expect(sheet(page)).toBeVisible()
  await page.setViewportSize({ width: WIDTHS.desktop, height: HEIGHT })
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByRole("complementary", { name: "Panel" })).toBeVisible()

  await page.setViewportSize({ width: WIDTHS.phone, height: HEIGHT })
  await railToggle(page).click()
  await expect(sheet(page)).toBeVisible()
  await page.setViewportSize({ width: WIDTHS.tablet, height: HEIGHT })
  await expect(sheet(page)).toHaveCount(0)
  await expect(
    page.getByRole("complementary", { name: "Workspace" })
  ).toBeVisible()
})

test("a modified click on a link leaves the sheet open", async ({ page }) => {
  await open(page, WIDTHS.phone)
  await railToggle(page).click()
  // Dispatched rather than clicked: a real modified click opens a new tab,
  // which is the browser's business and not what this asserts.
  await sheet(page)
    .getByRole("link", { name: "Staff" })
    .dispatchEvent("click", { button: 0, metaKey: true, bubbles: true })
  await sheet(page)
    .getByRole("link", { name: "Staff" })
    .dispatchEvent("click", { button: 1, bubbles: true })
  await expect(sheet(page)).toBeVisible()
})
