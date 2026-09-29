import { expect as baseExpect, test } from "@playwright/test"
import { ANSWERS, signIn, startOrg } from "./owner"
import { visit } from "./visit"
import {
  createProbeUser,
  deleteProbeOrgs,
  deleteProbeUser,
  PROBE_ORG_PREFIX,
} from "./workos"

/**
 * A new owner, end to end: signup makes the org and its onboarding
 * conversation, `/app` lands in it, the facts go in through the chat, and
 * the transcript is the same after a reload.
 *
 * `@live`, so the blocking smoke skips it: it writes tenant rows (an org,
 * facts, a conversation) that nothing can delete. The WorkOS user and org
 * are deleted at the end; the rows stay, and the dated address says which
 * run made them. Runs against local dev or a preview:
 *
 *   E2E_BASE_URL=<web> pnpm e2e --grep @live
 */

// Its own owner, not the smoke's session.
test.use({ storageState: { cookies: [], origins: [] } })

// A preview reads the staging database from wherever the run is: stored
// history took 8 to 17 s to load, measured from Dhaka.
const expect = baseExpect.configure({ timeout: 30_000 })
test.setTimeout(240_000)

test("@live a new owner is onboarded in the chat, and a reload keeps it", async ({
  page,
}) => {
  const day = new Date().toISOString().slice(0, 10)
  const user = await createProbeUser(`live-${day}-`)
  const business = `${PROBE_ORG_PREFIX}${day}`
  try {
    await signIn(page, user)

    await startOrg(page, user, business)

    // The new owner lands in onboarding, not on an empty new chat.
    await visit(page, "/app")
    await expect(page).toHaveURL(/\/app\/c\/[0-9a-f-]{36}$/)
    const onboarding = page.url()

    const pending = page.locator('[data-slot="ask-fact"] form')
    const answered = page.locator('[data-slot="ask-fact"]:not(:has(form))')
    const card = page.locator('[data-slot="request-change"]')
    // Signup gave the name, so the first question is the phone.
    let count = 0

    // Six facts at most: one guard against a script that never ends.
    while (count < 7) {
      await expect(pending.or(card).first()).toBeVisible()
      if (await card.count()) break
      // The next question takes the focus, so Enter answers it rather
      // than sending the composer's text over it.
      await expect(pending.locator("input").first()).toBeFocused()
      const question = await page
        .locator('[data-slot="ask-fact"]:has(form) p')
        .first()
        .innerText()
      const skip = pending.getByRole("button", { name: "Skip for now" })
      if (await skip.count()) {
        // Pricing, the one fact an owner may leave for later.
        await skip.click()
      } else {
        const answer = ANSWERS[question]
        expect(answer, `no answer for "${question}"`).toBeDefined()
        await answer?.(pending)
        await pending.getByRole("button", { name: "Save" }).click()
      }
      count += 1
      await expect(answered).toHaveCount(count)
    }
    // Phone, email, hours, area and the skipped price.
    expect(count).toBe(5)

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
        return button && composer
          ? button.y + button.height < composer.y
          : false
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
  } finally {
    await deleteProbeOrgs(user.id)
    expect(await deleteProbeUser(user.id)).toBe(true)
  }
})
