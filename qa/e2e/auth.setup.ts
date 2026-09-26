import { expect, test as setup } from "@playwright/test"
import { visit } from "./visit"
import {
  createProbeUser,
  deleteProbeUser,
  STORAGE_STATE,
  staleProbeUsers,
} from "./workos"

/**
 * The sign-in leg of the smoke path, and the session every other test reuses.
 *
 * It signs in through the form a person uses, not through the SDK. A suite that
 * seals its own cookie proves the pages render and proves nothing about whether
 * anyone can get to them, and getting to them is half of what this story is.
 */

setup(
  "the app refuses an anonymous visitor and accepts a real sign-in",
  async ({ page }) => {
    // Housekeeping first, so a run that died between creating an account and
    // deleting it does not leave its account on staging forever. Only our own
    // prefix, and only accounts too old to belong to a run in flight.
    for (const id of await staleProbeUsers()) {
      await deleteProbeUser(id)
    }

    const user = await createProbeUser()

    // The guard, before the credential exists in the browser at all: /app is not
    // reachable signed out, and it says where to come back to. The wait is for
    // the submit button specifically, because that is the element whose handler
    // the next three lines depend on.
    await visit(page, "/app", 'button[type="submit"]')
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fapp$/)

    await page.getByLabel("Email").fill(user.email)
    await page.getByLabel("Password").fill(user.password)
    await page.getByRole("button", { name: "Sign in" }).click()

    // `returnTo` carried through the sign-in, so the person lands where they were
    // sent from rather than on a generic home page.
    await expect(page).toHaveURL(/\/app$/)
    await expect(
      page.getByRole("heading", { name: "Waiting on you", level: 2 })
    ).toBeVisible()

    await page.context().storageState({ path: STORAGE_STATE })
  }
)
