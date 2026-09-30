import { spawnSync } from "node:child_process"
import { expect, type Page } from "@playwright/test"
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
  const cookie = await sessionCookie(page)
  const post = () =>
    api(cookie, "/org", {
      method: "POST",
      headers: { "idempotency-key": `org:${user.id}` },
      body: JSON.stringify({ name }),
    })
  // A transient 503 (WorkOS past the api's 3 s bound) is retried with the
  // same key, as the app's own org-write retry does; anything else fails.
  let org = await post()
  for (let tries = 1; org.status === 503 && tries < 3; tries++) {
    org = await post()
  }
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

/**
 * What a run types into each onboarding fact card, by the label of its one
 * input. The card's question is the same for every org, but the assistant's
 * line above it is not, so a card is known by its input.
 */
export const ANSWERS: Record<string, string> = {
  "Products or services, separated by commas":
    "Regular home cleaning, deep cleans, end of tenancy cleans",
  "Your customers": "Busy households and letting agents",
  "How you work":
    "Two teams of two, booked a week ahead, with our own products",
  "Towns, regions or postcodes": "Leeds and the villages around it",
  "Phone number": "07700 900123",
  "Email address": "hello@example.net",
  "Assistant's name": "Sam",
  "Your name": "Alex",
}

/** The option a choice card is answered with, when it offers it; else its first. */
const PICKS = ["Cleaning and home services", "Yes, build it for me"]

/**
 * The onboarding conversation answered through its cards until the first
 * build starts, anything skippable skipped. Signup recorded the name, so it
 * asks 18: the industry, offerings, customers, how the business runs, the
 * area, phone, email and tagline (skipped), the assistant's name, pronouns
 * and tone, the owner's name, whether to build the site (yes), its
 * template, colours, lettering and pages (as ticked), and photos (skipped).
 * The build then starts on its own, with no approval card. One round more
 * than that is the guard against a script that never ends, and the count
 * then fails. Returns how many facts the answers wrote.
 */
export async function answerOnboarding(page: Page): Promise<number> {
  // Each answer is a server round trip, and both callers run against a
  // deployment reading the staging database from wherever the run is.
  const slow = expect.configure({ timeout: 30_000 })
  const cards = page.locator(
    '[data-slot="ask-fact"], [data-slot="ask-choice"], [data-slot="ask-upload"]'
  )
  // An open card holds an input; an answered one only says what was chosen.
  const open = page.locator("form, input[type=file]")
  const pending = cards.filter({ has: open })
  const answered = cards.filter({ hasNot: open })
  const build = page.locator('[data-slot="request-change"]')
  const asked = 18
  let count = 0
  let stated = 0
  while (count <= asked) {
    await slow(pending.or(build).first()).toBeVisible()
    if (await build.count()) break
    const card = pending.first()
    // The next card takes the focus once its turn has finished streaming.
    await slow(card.locator("input").first()).toBeFocused()
    const skip = card.getByRole("button", { name: "Skip for now" })
    const slot = await card.getAttribute("data-slot")
    if (await skip.count()) {
      // The tagline and the photos, which an owner may leave for later.
      await skip.click()
    } else if (slot === "ask-choice") {
      // Pages come ticked; every other card takes one pick.
      if ((await card.getByRole("checkbox").count()) === 0) {
        const labels = card.locator("label")
        let pick = labels.first()
        for (const name of PICKS) {
          const offered = labels.filter({ hasText: name })
          if (await offered.count()) pick = offered.first()
        }
        await pick.click()
      }
      await card.getByRole("button", { name: "Continue" }).click()
      stated += 1
    } else {
      const label = await card.locator("form label").first().innerText()
      const answer = ANSWERS[label.trim()]
      expect(answer, `no answer for the card asking "${label}"`).toBeDefined()
      await card.getByLabel(label.trim(), { exact: true }).fill(answer ?? "")
      await card.getByRole("button", { name: "Save" }).click()
      stated += 1
    }
    count += 1
    await slow(answered).toHaveCount(count)
  }
  expect(count, "cards answered before the build started").toBe(asked)
  return stated
}

/**
 * Builds still open, stopped, so the probe cleanup (which refuses an org
 * with an unfinished assignment) can take the org. `cookie` reads the
 * session fresh, because the web refreshes it as the panel polls.
 */
export async function stopBuilds(cookie: () => Promise<string>) {
  const read = async () =>
    (
      (await (await api(await cookie(), "/workspace")).json()) as {
        builds?: { assignment_id: string }[]
      }
    ).builds ?? []
  for (const build of await read()) {
    await api(await cookie(), `/builds/${build.assignment_id}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
  }
  await expect.poll(read, { timeout: 120_000 }).toEqual([])
}
