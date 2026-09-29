import {
  expect,
  type Locator,
  type Page,
  type Request,
  test,
} from "@playwright/test"
import { signIn } from "./owner"
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

/**
 * What loading /sign-out asks the server for: the route's chunk, then its
 * loader's server functions (POSTs), the second of which is the sign-out.
 * Neither page here asks for either while the pointer rests.
 */
function startsSignOut(request: Request): boolean {
  const { pathname } = new URL(request.url())
  return (
    pathname.includes("sign-out") ||
    (request.method() === "POST" && pathname.startsWith("/_serverFn/"))
  )
}

/**
 * Hovers and focuses the target, then watches for longer than the router's
 * preload delay on intent: a preload would load /sign-out and sign out.
 */
async function pointAt(page: Page, target: Locator) {
  const started = page.waitForRequest(startsSignOut, { timeout: 1500 }).then(
    (request) => `${request.method()} ${request.url()}`,
    () => null
  )
  await target.hover()
  await target.focus()
  expect(await started, "pointing at Sign out loaded /sign-out").toBeNull()
}

async function expectSignedIn(page: Page) {
  await page.goto("/app/staff")
  await expect(page).toHaveURL(/\/app\/staff/)
  await hydrated(page, "main")
}

test("pointing at Sign out leaves the owner signed in", async ({ page }) => {
  await signIn(page, await createProbeUser(), "/app/account")
  await expect(page).toHaveURL(/\/app\/account$/)
  await hydrated(page, "main")

  const link = page.getByRole("main").getByRole("link", { name: "Sign out" })
  await pointAt(page, link)
  await expectSignedIn(page)

  await page.getByRole("button", { name: "Probe Runner" }).click()
  const item = page.getByRole("menuitem", { name: "Sign out" })
  await pointAt(page, item)
  await page.keyboard.press("Escape")
  await expectSignedIn(page)
})
