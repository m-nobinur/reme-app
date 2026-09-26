import { expect, type Page, test } from "@playwright/test"
import { hydrated } from "./visit"
import { createProbeUser } from "./workos"

/**
 * Pointing at Sign out must not sign anyone out. The router preloads a link's
 * route on hover and focus, and the /sign-out route signs out in its loader,
 * so a router link there ends the session before anyone clicks.
 *
 * Its own account, signed in here: the failure this guards against ends the
 * session, and ending the one every other spec shares would fail them too.
 */
test.use({ storageState: { cookies: [], origins: [] } })

async function signIn(page: Page) {
  const user = await createProbeUser()
  await page.goto("/sign-in?returnTo=%2Fapp%2Faccount")
  await hydrated(page, 'button[type="submit"]')
  await page.getByLabel("Email").fill(user.email)
  await page.getByLabel("Password").fill(user.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/app\/account$/)
  await hydrated(page, "main")
}

/** Longer than the router's preload delay on intent. */
async function linger(page: Page) {
  await page.waitForTimeout(1500)
}

async function expectSignedIn(page: Page) {
  await page.goto("/app/staff")
  await expect(page).toHaveURL(/\/app\/staff/)
  await hydrated(page, "main")
}

test("pointing at Sign out leaves the owner signed in", async ({ page }) => {
  await signIn(page)

  const link = page.getByRole("main").getByRole("link", { name: "Sign out" })
  await link.hover()
  await link.focus()
  await linger(page)
  await expectSignedIn(page)

  await page.getByRole("button", { name: "Probe Runner" }).click()
  const item = page.getByRole("menuitem", { name: "Sign out" })
  await item.hover()
  await item.focus()
  await linger(page)
  await page.keyboard.press("Escape")
  await expectSignedIn(page)
})
