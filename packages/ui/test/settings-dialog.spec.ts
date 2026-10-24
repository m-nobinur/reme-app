import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The settings modal, opened from the rail's avatar: a list of pages beside
 * the chosen one from `md`, and one at a time on a phone. Focus stays in it
 * while it is open and goes back to the avatar when it closes.
 */

const PHONE = 390
const DESKTOP = 1280

const trigger = (page: Page) =>
  page.getByRole("button", { name: "Settings, Sam Fixture" })
const dialog = (page: Page) => page.getByRole("dialog", { name: "Settings" })
const row = (page: Page, name: string) =>
  dialog(page)
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", {
      name,
    })
const heading = (page: Page) => dialog(page).getByRole("heading").last()

/** Opens the modal and waits for its entry transition, so a scan sees final colours. */
async function openSettings(page: Page) {
  await trigger(page).click()
  await expect(dialog(page)).toBeVisible()
  // The transition starts only once the starting style comes off, a frame
  // after the popup mounts; waited on before that, it is not yet running.
  await expect(dialog(page)).not.toHaveAttribute("data-starting-style")
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((each) => each.finished.catch(() => null))
    )
  )
}

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of [
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ] as const) {
    test(`settings have no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, "Settings", width, theme)
      await openSettings(page)
      await axe(page, `${name} ${theme} list`)
      await row(page, "Website").click()
      await axe(page, `${name} ${theme} page`)
    })
  }
}

test("from md the list and the chosen page share the modal", async ({
  page,
}) => {
  await open(page, "Settings", DESKTOP)
  await openSettings(page)
  const box = await dialog(page).boundingBox()
  expect(box?.width).toBeLessThan(DESKTOP)
  const radius = await dialog(page).evaluate(
    (node) => getComputedStyle(node).borderTopLeftRadius
  )
  expect(Number.parseFloat(radius)).toBeGreaterThanOrEqual(28)

  await expect(row(page, "General")).toHaveAttribute("aria-current", "true")
  await expect(heading(page)).toHaveText("General")
  await row(page, "Legal info").click()
  await expect(heading(page)).toHaveText("Legal info")
  await expect(row(page, "Legal info")).toHaveAttribute("aria-current", "true")
  await expect(row(page, "Legal info")).toBeFocused()
  await expect(
    dialog(page).getByRole("button", { name: "Back to settings" })
  ).toBeHidden()
  await expect(
    dialog(page).getByRole("link", { name: "Log out" })
  ).toBeVisible()
})

test("on a phone it fills the screen, list first and then the page", async ({
  page,
}) => {
  await open(page, "Settings", PHONE)
  await openSettings(page)
  const box = await dialog(page).boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0, width: PHONE, height: 900 })

  await expect(row(page, "General")).toBeVisible()
  await expect(dialog(page).getByRole("region")).toBeHidden()
  await row(page, "Website").click()
  await expect(row(page, "Website")).toBeHidden()
  await expect(heading(page)).toHaveText("Website")
  const back = dialog(page).getByRole("button", { name: "Back to settings" })
  await expect(back).toBeFocused()

  await back.click()
  await expect(row(page, "Website")).toBeFocused()
})

test("it traps focus, closes on Escape and returns focus to the avatar", async ({
  page,
}) => {
  await open(page, "Settings", DESKTOP)
  await trigger(page).focus()
  await page.keyboard.press("Enter")
  await expect(dialog(page)).toBeVisible()
  for (const key of [...Array(12).fill("Tab"), ...Array(4).fill("Shift+Tab")]) {
    await page.keyboard.press(key)
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              !!document.activeElement?.closest(
                '[data-slot="settings-content"]'
              )
          ),
        { message: `focus left the modal after ${key}`, timeout: 1000 }
      )
      .toBe(true)
  }
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  await expect(trigger(page)).toBeFocused()
})

test("the close button closes it, and so does a link in a page", async ({
  page,
}) => {
  await open(page, "Settings", DESKTOP)
  await openSettings(page)
  await dialog(page).getByRole("button", { name: "Close settings" }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(trigger(page)).toBeFocused()

  await openSettings(page)
  await row(page, "Website").click()
  await dialog(page)
    .getByRole("link", { name: "Open the website page" })
    .click()
  await expect(dialog(page)).toHaveCount(0)
})
