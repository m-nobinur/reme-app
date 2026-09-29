import { spawnSync } from "node:child_process"
import { expect, type Locator, type Page } from "@playwright/test"
import { visit } from "./visit"
import { deleteProbeOrgs, deleteProbeUser, type ProbeUser } from "./workos"

/**
 * An owner with an organisation, for the specs that make one: sign in, make
 * the org the way signup does, call `apps/api` with the browser's session,
 * and clear the org again.
 */

const ROOT = new URL("../../", import.meta.url)

/** `apps/api` beside the web under test, or `E2E_API_URL`. */
export function apiUrl(): string {
  if (process.env.E2E_API_URL) return process.env.E2E_API_URL
  const web = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000")
  if (web.hostname === "localhost") return "http://localhost:3001"
  if (web.hostname === "staging.remeai.co.uk") {
    return "https://staging-api.remeai.co.uk"
  }
  if (web.hostname.endsWith("-reme-web.beapp.workers.dev")) {
    return web.origin.replace("-reme-web.", "-reme-api.")
  }
  throw new Error(`Set E2E_API_URL: no api is known beside ${web.origin}.`)
}

/** Through the sign-in form, to `/app` or to `returnTo` when given. */
export async function signIn(page: Page, user: ProbeUser, returnTo?: string) {
  const path = returnTo
    ? `/sign-in?returnTo=${encodeURIComponent(returnTo)}`
    : "/sign-in"
  await visit(page, path, 'button[type="submit"]')
  await page.getByLabel("Email").fill(user.email)
  await page.getByLabel("Password").fill(user.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL(/\/app/)
}

/** The browser's session as a `cookie` header, read fresh each call. */
export async function sessionCookie(page: Page): Promise<string> {
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === "wos-session"
  )
  expect(session, "the sign-in set no session cookie").toBeDefined()
  return `wos-session=${session?.value}`
}

/** `apps/api` as the signed-in owner. */
export async function api(
  cookie: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie,
      ...init.headers,
    },
  })
}

/**
 * Signup's own write, as `pnpm dev:session` makes it: the org, its starting
 * team and its onboarding conversation. A session minted before the org
 * carries no org claim, so the owner signs in again and lands in the only
 * membership.
 */
export async function startOrg(
  page: Page,
  user: ProbeUser,
  name: string
): Promise<{ org_id: string }> {
  const org = await api(await sessionCookie(page), "/org", {
    method: "POST",
    headers: { "idempotency-key": `org:${user.id}` },
    body: JSON.stringify({ name }),
  })
  expect(org.status, await org.clone().text()).toBeLessThan(300)
  await page.goto("/sign-out")
  await signIn(page, user)
  return (await org.json()) as { org_id: string }
}

/**
 * A probe org cleared whole, then its owner. The org goes by its id through
 * `pnpm probe:clear`; WorkOS alone is the fallback when signup died before
 * the id came back or the clear refused, and then its Postgres rows stay for
 * `pnpm probe:clear --org`. Returns what is left, empty when nothing is.
 */
export async function clearProbe(
  orgId: string | null,
  user: ProbeUser
): Promise<string[]> {
  const failures: string[] = []
  let cleared = false
  if (orgId) {
    const clear = spawnSync(
      "pnpm",
      ["probe:clear", "--probe", orgId, "--yes"],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    )
    cleared = clear.status === 0
    // 3: no such org in staging's Postgres, as on a preview, whose Neon
    // branch goes with the PR; only the WorkOS org is left to delete.
    if (!cleared && clear.status !== 3) {
      failures.push(
        `pnpm probe:clear --probe ${orgId} exited ${clear.status}; its rows stay, clear them with --org`
      )
    }
  }
  if (!cleared) {
    await deleteProbeOrgs(user.id).catch((error) =>
      failures.push(`WorkOS orgs not deleted: ${error}`)
    )
  }
  if (!(await deleteProbeUser(user.id))) {
    failures.push(`WorkOS user ${user.id} still exists`)
  }
  return failures
}

/** How a run answers each onboarding question, by the question the owner reads. */
export const ANSWERS: Record<string, (form: Locator) => Promise<void>> = {
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

/**
 * The onboarding conversation answered through its cards until the offer of
 * the first build shows, pricing skipped. Signup recorded the name, so it asks
 * five: phone, email, hours, area and price. One round more than that is the
 * guard against a script that never ends, and the count then fails.
 */
export async function answerOnboarding(page: Page): Promise<void> {
  // Each answer is a server round trip, and both callers run against a
  // deployment reading the staging database from wherever the run is.
  const slow = expect.configure({ timeout: 30_000 })
  const pending = page.locator('[data-slot="ask-fact"] form')
  const answered = page.locator('[data-slot="ask-fact"]:not(:has(form))')
  const card = page.locator('[data-slot="request-change"]')
  const asked = 5
  let count = 0
  while (count <= asked) {
    await slow(pending.or(card).first()).toBeVisible()
    if (await card.count()) break
    // The next question takes the focus, so Enter answers it rather than
    // sending the composer's text over it.
    await slow(pending.locator("input").first()).toBeFocused()
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
    await slow(answered).toHaveCount(count)
  }
  expect(count, "questions asked before the offer of a build").toBe(asked)
}
