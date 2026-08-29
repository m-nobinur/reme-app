import { expect, test } from "@playwright/test"
import { createProbeUser } from "./workos"

/**
 * The regression guard for the sign-in form's pre-hydration window.
 *
 * These pages arrive as HTML and their submit handler arrives with the
 * JavaScript. A click in between used to submit the form natively: no `action`,
 * so it posted back to a URL no route answers, the credentials were discarded,
 * and the person landed on the sign-in page again or on "We could not reach the
 * sign-in service". Measured on staging at five failures in thirty attempts.
 *
 * A capturing listener installed from `<head>` now cancels that submit and marks
 * the form, and `AuthForm` replays it on hydration. Measured against a local
 * dev build, where the window is widest: with the guard neutralised, 0 of 30
 * attempts signed in and all 30 landed back on the sign-in page; with it live,
 * 30 of 30 signed in. Every click in both arms happened before hydration.
 *
 * Two assertions, because one of them is only sometimes exercised. The
 * behavioural one below cannot guarantee it lands inside the window on a fast
 * preview, so the mechanism is asserted directly as well: delete the guard from
 * the document and this file goes red whatever the timing did.
 */

// A fresh, signed-out context. Every other spec runs as the session the setup
// project sealed, and this one is about getting a session in the first place.
test.use({ storageState: { cookies: [], origins: [] } })

test("the document carries the pre-hydration submit guard", async ({
  page,
}) => {
  await page.goto("/sign-in")

  const guarded = await page.locator("form[data-auth-form]").count()
  expect(guarded, "the sign-in form is not marked for the guard").toBe(1)

  const scripts = await page.locator("head script").allTextContents()
  expect(
    scripts.some(
      (source) =>
        source.includes('addEventListener("submit"') &&
        source.includes("preventDefault")
    ),
    "no inline submit guard in <head>: a click before hydration is lost again"
  ).toBe(true)
})

test("a sign-in clicked before hydration still signs in", async ({ page }) => {
  const user = await createProbeUser()

  // `domcontentloaded`, and no `visit()`. The wait `visit()` performs is the
  // workaround this test exists to make unnecessary, so using it here would
  // assert nothing.
  await page.goto("/sign-in?returnTo=%2Fapp", { waitUntil: "domcontentloaded" })
  await page.waitForSelector("#email", { state: "attached" })
  await page.fill("#email", user.email)
  await page.fill("#password", user.password)
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
})
