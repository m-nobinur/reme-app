import { expect as baseExpect, test } from "@playwright/test"
import {
  answerOnboarding,
  api,
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
 * conversation, `/app` lands in it, the owner answers the assistant in the
 * chat, by card or in words, the first build starts on its own, and the
 * transcript is the same after a reload.
 *
 * `@live`, so the blocking smoke skips it: a model plans each turn, and the
 * confirmed quote form starts a real build, which spends on the model key until it is stopped at
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
// Up to 45 planner turns, each up to 45 s.
test.setTimeout(30 * 60_000)

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

  await answerOnboarding(page)
  const card = page.locator('[data-slot="request-change"]')

  // The first build, started on its own once the quote form was confirmed:
  // the card says it started and asks nothing, and no approval was asked.
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("Build my website")
  await expect(card).toContainText("Started. Follow it under Working on.")
  await expect(card.getByRole("button")).toHaveCount(0)
  await expect(page.locator('[data-slot^="approval-"]')).toHaveCount(0)
  const workspace = (await (
    await api(await sessionCookie(page), "/workspace")
  ).json()) as { builds?: unknown[] }
  expect(workspace.builds ?? []).toHaveLength(1)

  // The conversation's words, the owner's and the assistant's, the same
  // after a reload.
  const transcript = page.locator(
    '[data-slot="aui_assistant-message-content"], .aui-user-message-content'
  )
  const live = await transcript.allTextContents()
  await page.reload()
  await expect.poll(() => transcript.allTextContents()).toEqual(live)
  expect(page.url()).toBe(onboarding)

  // A build is under way, so /app is a new chat, not onboarding.
  await visit(page, "/app")
  await expect(page).toHaveURL(/\/app\/?$/)

  // What the build needs, written as facts.
  const { facts } = (await (
    await api(await sessionCookie(page), "/facts")
  ).json()) as { facts: { key: string }[] }
  expect(facts.map((fact) => fact.key)).toEqual(
    expect.arrayContaining([
      "business.name",
      "business.phone",
      "business.email",
      "business.industry",
      "business.offerings",
      "service_area.text",
      "assistant.name",
      "owner.preferred_name",
      "site.template",
      "site.palette",
      "site.font",
      "site.pages",
      "quote.form",
    ])
  )
})
