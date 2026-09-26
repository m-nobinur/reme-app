import { expect, type Page, test } from "@playwright/test"
import { visit } from "./visit"
import {
  createProbeUser,
  deleteProbeOrgs,
  deleteProbeUser,
  type ProbeUser,
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

/** `apps/api` beside the web under test, or `E2E_API_URL`. */
function apiUrl(): string {
  if (process.env.E2E_API_URL) return process.env.E2E_API_URL
  const web = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000")
  if (web.hostname === "localhost") return "http://localhost:3001"
  if (web.hostname.endsWith("-reme-web.beapp.workers.dev")) {
    return web.origin.replace("-reme-web.", "-reme-api.")
  }
  throw new Error(`Set E2E_API_URL: no api is known beside ${web.origin}.`)
}

async function signIn(page: Page, user: ProbeUser) {
  await visit(page, "/sign-in", 'button[type="submit"]')
  await page.getByLabel("Email").fill(user.email)
  await page.getByLabel("Password").fill(user.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL(/\/app/)
}

/** How the run answers each question, by the question the owner reads. */
const ANSWERS: Record<
  string,
  (form: ReturnType<Page["locator"]>) => Promise<void>
> = {
  "What number should customers ring?": async (form) => {
    await form.getByLabel("Phone number").fill("07700 900123")
  },
  "Which email address should enquiries go to?": async (form) => {
    await form.getByLabel("Email address").fill("hello@example.net")
  },
  "What are your hours on weekdays?": async (form) => {
    await form.getByLabel("Opening time").fill("08:00")
    await form.getByLabel("Closing time").fill("18:00")
  },
  "Where do you work from, and how far do you travel?": async (form) => {
    await form.getByLabel("Town or postcode you work from").fill("Leeds")
    await form.getByLabel("Distance you travel, in km").fill("15")
  },
}

test("@live a new owner is onboarded in the chat, and a reload keeps it", async ({
  page,
}) => {
  const day = new Date().toISOString().slice(0, 10)
  const user = await createProbeUser(`live-${day}-`)
  const business = `Probe Cleaning ${day}`
  try {
    await signIn(page, user)

    // Signup's own write, as `pnpm dev:session` makes it: the org, its
    // starting team and its onboarding conversation.
    const session = (await page.context().cookies()).find(
      (cookie) => cookie.name === "wos-session"
    )
    expect(session, "the sign-in set no session cookie").toBeDefined()
    const org = await fetch(`${apiUrl()}/org`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `wos-session=${session?.value}`,
        "idempotency-key": `org:${user.id}`,
      },
      body: JSON.stringify({ name: business }),
    })
    expect(org.status, await org.clone().text()).toBeLessThan(300)
    // A session minted before the org carries no org claim; the next one
    // lands in the only membership.
    await page.goto("/sign-out")
    await signIn(page, user)

    // The new owner lands in onboarding, not on an empty new chat.
    await visit(page, "/app")
    await expect(page).toHaveURL(/\/app\/c\/[0-9a-f-]{36}$/)
    const onboarding = page.url()

    const pending = page.locator('[data-slot="ask-fact"] form')
    const answered = page.locator('[data-slot="ask-fact"]:not(:has(form))')
    const card = page.locator('[data-slot="request-change"]')
    // The business name comes filled in from signup.
    await expect(page.getByLabel("Business name")).toHaveValue(business)
    await pending.getByRole("button", { name: "Save" }).click()
    let count = 1
    await expect(answered).toHaveCount(count)

    // Six facts at most: one guard against a script that never ends.
    while (count < 7) {
      await expect(pending.or(card).first()).toBeVisible({ timeout: 15_000 })
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
    // Name, phone, email, hours, area and the skipped price.
    expect(count).toBe(6)

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
    // Every fact the chat took, and none from anywhere else.
    await expect(facts.getByText(/^You told Reme/)).toHaveCount(5)
  } finally {
    await deleteProbeOrgs(user.id)
    expect(await deleteProbeUser(user.id)).toBe(true)
  }
})
