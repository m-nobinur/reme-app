import { expect as baseExpect, test } from "@playwright/test"
import {
  answerOnboarding,
  clearProbe,
  sessionCookie,
  signIn,
  startOrg,
  stopBuilds,
} from "./owner"
import { visit } from "./visit"
import { createProbeUser, PROBE_ORG_PREFIX, type ProbeUser } from "./workos"

/**
 * A new owner, end to end: signup makes the org and its onboarding
 * conversation, `/app` lands in it, every card is answered in the chat,
 * the first build starts on its own, and the transcript is the same after a
 * reload.
 *
 * `@live`, so the blocking smoke skips it: the yes to "build it for me"
 * starts a real build, which spends on the model key until it is stopped at
 * the end. The org is then cleared whole with `pnpm probe:clear`, pass or
 * fail, and then its owner. Runs against staging or a preview:
 *
 *   E2E_BASE_URL=<web> pnpm e2e --grep @live
 */

// Its own owner, not the smoke's session.
test.use({ storageState: { cookies: [], origins: [] } })

// A preview reads the staging database from wherever the run is: stored
// history took 8 to 17 s to load, measured from Dhaka.
const expect = baseExpect.configure({ timeout: 30_000 })
// Eighteen cards, each a round trip, where there used to be four.
test.setTimeout(600_000)

let user: ProbeUser | null = null
let orgId: string | null = null

// Stopped while the page and its session are still open: the probe
// cleanup refuses an org with an unfinished build.
test.afterEach(async ({ page }) => {
  if (orgId) await stopBuilds(() => sessionCookie(page))
})

test.afterAll(async () => {
  test.setTimeout(3 * 60_000)
  if (!user) return
  expect(
    await clearProbe(orgId, user),
    "the run left something behind"
  ).toEqual([])
})

test("@live a new owner is onboarded in the chat, and a reload keeps it", async ({
  page,
}) => {
  const day = new Date().toISOString().slice(0, 10)
  user = await createProbeUser(`live-${day}-`)
  const business = `${PROBE_ORG_PREFIX}${day}`
  await signIn(page, user)

  orgId = (await startOrg(page, user, business)).org_id

  // The new owner lands in onboarding, not on an empty new chat.
  await visit(page, "/app")
  await expect(page).toHaveURL(/\/app\/c\/[0-9a-f-]{36}$/)
  const onboarding = page.url()

  const stated = await answerOnboarding(page)
  const card = page.locator('[data-slot="request-change"]')

  // The first build, started by the script: the yes in the chat was the
  // approval, so the card says it started and asks nothing.
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("Build my website")
  await expect(card).toContainText("Started. Follow it under Working on.")
  await expect(card.getByRole("button")).toHaveCount(0)

  const transcript = page.locator(
    '[data-slot="ask-fact"], [data-slot="ask-choice"], [data-slot="ask-upload"], [data-slot="request-change"]'
  )
  const live = await transcript.allInnerTexts()
  await page.reload()
  await expect.poll(() => transcript.allInnerTexts()).toEqual(live)
  expect(page.url()).toBe(onboarding)

  // A build is under way, so /app is a new chat, not onboarding.
  await visit(page, "/app")
  await expect(page).toHaveURL(/\/app\/?$/)

  // The facts are the owner's own words on the profile.
  await visit(page, "/app/profile")
  const facts = page.getByRole("main")
  await expect(
    facts.getByRole("definition").filter({ hasText: business })
  ).toBeVisible()
  await expect(
    facts.getByText("Leeds and the villages around it")
  ).toBeVisible()
  // The name from signup and every fact the chat took, and none else.
  await expect(facts.getByText(/^You told Reme/)).toHaveCount(1 + stated)
})
