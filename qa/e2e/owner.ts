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

/**
 * The browser's session as the `cookie` header the api reads, fresh each call.
 * The browser holds it as `__Host-wos-session` on https; the api's name is
 * `wos-session` either way.
 */
export async function sessionCookie(page: Page): Promise<string> {
  const session = (await page.context().cookies()).find((cookie) =>
    ["__Host-wos-session", "wos-session"].includes(cookie.name)
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

/** What the owner of a Leeds cleaning firm opens with. */
const OPENING =
  "Hi! We're a cleaning company in Leeds. We do regular home cleaning, deep cleans and end of tenancy cleans."

/**
 * The owner's reply, picked by what the assistant just asked or by a fact
 * card's label. First match wins, so the email comes before anything that
 * mentions quotes, and the assistant's name before the owner's.
 */
const REPLIES: [RegExp, string][] = [
  [
    /assistant'?s name|name (for )?(me|yourself)|call me\b|go by|introduce myself|name.*assistant/i,
    "Sam",
  ],
  [/your name|call you/i, "Alex"],
  [
    /(phone|number).*e-?mail|e-?mail.*(phone|number)/i,
    "07700 900123, hello@example.net",
  ],
  [/e-?mail/i, "hello@example.net"],
  [/phone|number|ring/i, "07700 900123"],
  [/slogan|tagline|one line|sum up/i, "No slogan yet."],
  [/charge|price|cost/i, "Regular clean £60, deep clean £180"],
  [
    /quote|need to know|before you (can|could)/i,
    "The size of the home, how many bedrooms and bathrooms, the kind of clean, and the date they want.",
  ],
  [/customers|clients|who .*(book|for)/i, "Busy households and letting agents"],
  [
    /area|towns|postcode|cover|travel|where/i,
    "Leeds and the villages around it",
  ],
  [
    /how you work|run|operate|day to day|typical|first (contact|enquiry)/i,
    "Two teams of two, booked a week ahead, with our own products",
  ],
  [
    /products|services|offer|sell/i,
    "Regular home cleaning, deep cleans, end of tenancy cleans",
  ],
]
const reply = (asked: string) =>
  REPLIES.find(([pattern]) => pattern.test(asked))?.[1] ?? "You choose."

/** The option a choice card is answered with, when it offers it; else its first. */
const PICKS = ["Cleaning and home services", "Yes, build it for me"]

/**
 * The onboarding conversation played as an owner would, until the first
 * build starts. A model plans each turn: some questions come as a card,
 * others as plain chat answered in the composer, and an answered card
 * renders nothing. So each step waits for the assistant to finish, answers
 * the open card if there is one, else replies to its last question. The
 * build starts on its own once the quote form is confirmed. A turn budget
 * guards against a conversation that never ends.
 */
export async function answerOnboarding(page: Page): Promise<void> {
  // A planner turn can take 45 s, read from wherever the run is.
  const slow = expect.configure({ timeout: 90_000 })
  const assistant = page.locator('[data-slot="aui_assistant-message-root"]')
  const pending = page
    .locator(
      '[data-slot="ask-open"], [data-slot="ask-fact"], [data-slot="ask-details"], [data-slot="ask-choice"], [data-slot="ask-design"], [data-slot="ask-upload"], [data-slot="review-quote-form"]'
    )
    .filter({ has: page.locator("form, input[type=file], button") })
  const started = page
    .locator('[data-slot="request-change"]')
    .filter({ hasText: "Started" })
  const input = page.getByLabel("Message input")
  const settled = async () => {
    await slow(
      page.getByRole("button", { name: "Stop generating" })
    ).toBeHidden()
    await slow(
      page.locator('[data-slot="aui_assistant-message-indicator"]')
    ).toHaveCount(0)
  }
  // Each step is its own assistant message, so an answer has landed once
  // one more has arrived and finished.
  const step = async (act: () => Promise<void>) => {
    const before = await assistant.count()
    await act()
    await slow.poll(() => assistant.count()).toBeGreaterThan(before)
    await settled()
  }
  const say = (text: string) =>
    step(async () => {
      await input.fill(text)
      await input.press("Enter")
    })

  // The opener first, on this conversation. Until its history is in, the
  // page shows a placeholder thread, where `settled` holds at once and a
  // message would start another conversation.
  const conversation = page.url()
  await slow(assistant.first()).toBeVisible()
  await settled()
  await expect(page).toHaveURL(conversation)
  let opened = false
  for (let turn = 0; turn < 45; turn++) {
    if (await started.count()) return
    if (!(await pending.count())) {
      if (!opened) {
        opened = true
        await say(OPENING)
        continue
      }
      const said = (await assistant.last().innerText()).replace(/\s+/g, " ")
      const question = said
        .split(/(?<=[.?!])\s+/)
        .filter((sentence) => sentence.includes("?"))
        .at(-1)
      await say(reply(question ?? said))
      continue
    }
    opened = true
    const card = pending.last()
    const slot = await card.getAttribute("data-slot")
    if (slot === "ask-upload") {
      await step(() =>
        card.getByRole("button", { name: "Skip", exact: true }).click()
      )
    } else if (slot === "ask-design") {
      // The design tray opens on whether they have a logo, nothing picked.
      // No moves on to the designs drawn as it opened and keeps the first as
      // it lands; Pick for me then sends that logo and the picks already made.
      const no = card.getByRole("radio", { name: /^No, create one for me/ })
      if (await no.isVisible()) {
        await step(() => no.click())
        await expect(
          card
            .getByRole("radiogroup", { name: "Logo designs" })
            .getByRole("radio", { checked: true })
        ).toBeVisible({ timeout: 90_000 })
      }
      await step(() =>
        card.getByRole("button", { name: "Pick for me", exact: true }).click()
      )
    } else if (slot === "review-quote-form") {
      await step(() =>
        card.getByRole("button", { name: "Use this form" }).click()
      )
    } else if (slot === "ask-details") {
      // One field a page: an empty text field from the sheet, by its label,
      // a prefilled email stays, and a set of chips takes its first option.
      // Next until the last page, which reads Submit, or Looks good on a
      // tray that opened filled.
      for (;;) {
        for (const field of await card.getByRole("textbox").all()) {
          if (!(await field.isVisible()) || (await field.inputValue())) continue
          const label = await field.evaluate(
            (el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? ""
          )
          await field.fill(reply(label))
        }
        for (const set of await card.locator("fieldset").all()) {
          if (!(await set.isVisible())) continue
          if (!(await set.locator("input:checked").count())) {
            await set.locator("label").first().click()
          }
        }
        const next = card.getByRole("button", { name: "Next", exact: true })
        if (!(await next.count())) break
        await next.click()
      }
      await step(() =>
        card.getByRole("button", { name: /^(Submit|Looks good)$/ }).click()
      )
    } else if (slot === "ask-choice") {
      // A choice of two answers on its tap, with no Submit.
      const submit = card.getByRole("button", { name: "Submit" })
      if (!(await submit.count())) {
        const options = card.locator("form button")
        let pick = options.first()
        for (const name of PICKS) {
          const offered = options.filter({ hasText: name })
          if (await offered.count()) pick = offered.first()
        }
        await step(() => pick.click())
        continue
      }
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
      await step(() => submit.click())
    } else if (slot === "ask-open") {
      // Answered from the assistant's own words, as a typed reply would be.
      const said = (await assistant.last().innerText()).replace(/\s+/g, " ")
      await card.getByRole("textbox").fill(reply(said))
      await step(() => card.getByRole("button", { name: "Submit" }).click())
    } else {
      const label = (
        await card.locator("form label").first().innerText()
      ).trim()
      const field = card.getByLabel(label, { exact: true })
      // The owner's name opens with the one they signed in with.
      if (!(await field.inputValue())) await field.fill(reply(label))
      await step(() => card.getByRole("button", { name: "Submit" }).click())
    }
  }
  await expect(started, "the build had not started after 45 turns").toHaveCount(
    1
  )
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
