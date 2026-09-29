import { expect as baseExpect, test } from "@playwright/test"
import { answerOnboarding, clearProbe, signIn, startOrg } from "./owner"
import { visit } from "./visit"
import { createProbeUser, PROBE_ORG_PREFIX, type ProbeUser } from "./workos"

/**
 * A new owner, end to end: signup makes the org and its onboarding
 * conversation, `/app` lands in it, the facts go in through the chat, and
 * the transcript is the same after a reload.
 *
 * `@live`, so the blocking smoke skips it: the message typed after the
 * offer is a Chief of Staff turn, which spends on the model key. The org is
 * cleared whole at the end with `pnpm probe:clear`, pass or fail, and then
 * its owner. Runs against staging or a preview:
 *
 *   E2E_BASE_URL=<web> pnpm e2e --grep @live
 */

// Its own owner, not the smoke's session.
test.use({ storageState: { cookies: [], origins: [] } })

// A preview reads the staging database from wherever the run is: stored
// history took 8 to 17 s to load, measured from Dhaka.
const expect = baseExpect.configure({ timeout: 30_000 })
test.setTimeout(240_000)

let user: ProbeUser | null = null
let orgId: string | null = null

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

  await answerOnboarding(page)
  const card = page.locator('[data-slot="request-change"]')

  // The offer of the first build, which this run declines: a yes would
  // start a real build.
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("Build my website")
  // In view above the composer, not under it: each turn anchors at the
  // top, so the card has to bring itself into view.
  const approve = card.getByRole("button", { name: "Approve" })
  await expect
    .poll(async () => {
      const button = await approve.boundingBox()
      const composer = await page.getByLabel("Message input").boundingBox()
      return button && composer ? button.y + button.height < composer.y : false
    })
    .toBe(true)
  await card.getByRole("button", { name: "Not now" }).click()
  await expect(card).toContainText("You said not now.")

  // A typed message after a no leaves the no as it was, live and after
  // a reload. assistant-ui's own cancel used to turn it into "cancelled"
  // on screen only.
  await page.getByLabel("Message input").fill("Add Saturday hours, 9 to 1.")
  await page.getByLabel("Send message").click()
  await expect(card).toHaveCount(2)
  await expect(card.first()).toContainText("You said not now.")
  const live = await page
    .locator('[data-slot="ask-fact"], [data-slot="request-change"]')
    .allInnerTexts()

  await page.reload()
  await expect(card).toHaveCount(2)
  expect(
    await page
      .locator('[data-slot="ask-fact"], [data-slot="request-change"]')
      .allInnerTexts()
  ).toEqual(live)
  expect(page.url()).toBe(onboarding)

  // Still new (nothing built), so /app still lands in onboarding.
  await visit(page, "/app")
  await expect(page).toHaveURL(onboarding)

  // The facts are the owner's own words on the profile.
  await visit(page, "/app/profile")
  const facts = page.getByRole("main")
  await expect(
    facts.getByRole("definition").filter({ hasText: business })
  ).toBeVisible()
  await expect(facts.getByText("Leeds, within 15 km")).toBeVisible()
  // The name from signup and every fact the chat took, and none else.
  await expect(facts.getByText(/^You told Reme/)).toHaveCount(5)
})
