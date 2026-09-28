import { spawnSync } from "node:child_process"
import {
  expect as baseExpect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test"
import postgres from "postgres"
import { ANSWERS, api, sessionCookie, signIn, startOrg } from "./owner"
import { visit } from "./visit"
import {
  createProbeUser,
  deleteProbeOrgs,
  deleteProbeUser,
  PROBE_ORG_PREFIX,
  type ProbeUser,
} from "./workos"

/**
 * The golden path on staging, through the UI a new owner uses: signup,
 * onboarding with pricing skipped, the first build, its pricing question
 * answered in the panel, v1 approved and live with the price and its
 * thumbnail, the panel's blank-state actions, a Chief of Staff change to
 * v2, a reminder from each source added and completed in the panel, and
 * the api's own reads of what the run wrote. The org is
 * cleared whole at the end, pass or fail.
 *
 * `@live`: it starts two real builds and several Chief of Staff turns, so
 * it spends on the OpenRouter keys and takes one of staging's five sandbox
 * containers for most of its run. Run it outside the nightly window, and
 * only when that spend is agreed: `pnpm e2e:golden` (qa/e2e/README.md).
 */

test.use({
  storageState: { cookies: [], origins: [] },
  // "Tomorrow at 10am" means London time, whatever machine runs this.
  timezoneId: "Europe/London",
})

const expect = baseExpect.configure({ timeout: 30_000 })

/**
 * Builds took 115 to 313 s when the polling interval was chosen, and the
 * pricing question arrived 28 s into the S exit's build. Each wait below is
 * the top of that range with room, and every one polls the page.
 */
const WAIT = {
  question: 360_000,
  approval: 480_000,
  publish: 180_000,
  chat: 120_000,
}
test.setTimeout(50 * 60_000)

/** The answer to the pricing question, and how the live page prints it. */
const PRICE = { pounds: "28", shown: "£28.00" }

const ROOT = new URL("../../", import.meta.url)

const day = new Date().toISOString().slice(0, 10)
/**
 * Letters only. The content gate reads a run of 7 or more digits as a
 * phone number, and a date in the hero ("2026-09-28") is one, so a dated
 * hero fails the build. The date is in the org's name instead.
 */
const token = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (n) => "abcdefghijklmnopqrstuvwxyz"[n % 26]
).join("")
const HERO = `Spotless homes, golden run ${token}`

/** What the run records, printed and attached whether it passes or not. */
const run = {
  base_url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  business: `${PROBE_ORG_PREFIX}${day} golden ${token}`,
  started_at: new Date().toISOString(),
  org_id: null as string | null,
  seconds: {} as Record<string, number>,
  total_seconds: 0,
  blank_state_actions: {} as Record<string, string>,
  openrouter_usage_usd: {} as Record<
    string,
    { before: number | null; after: number | null; delta: number | null }
  >,
  notes: [] as string[],
}

let user: ProbeUser | null = null
let cookie = ""

async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  const began = Date.now()
  try {
    return await test.step(name, body)
  } finally {
    run.seconds[name] = Math.round((Date.now() - began) / 1000)
  }
}

function note(text: string) {
  run.notes.push(text)
  test.info().annotations.push({ type: "note", description: text })
}

/**
 * The keys a run spends on, by the variable that holds them: the one
 * `.env.local` gives the orchestrator's Developer, and the api's dedicated
 * Chief of Staff key when it is a different one (`OPENROUTER_KEY`, as
 * `cos-measure.mjs` names it). A key's usage is its whole spend, so another
 * run on the same key in the window counts here too.
 */
function openrouterKeys(): [string, string][] {
  const keys: [string, string][] = []
  for (const name of ["OPENROUTER_API_KEY", "OPENROUTER_KEY"]) {
    const value = process.env[name]
    if (value && !keys.some(([, seen]) => seen === value)) {
      keys.push([name, value])
    }
  }
  return keys
}

/** `GET /api/v1/key`'s `data.usage`, in dollars, or null when unread. */
async function keyUsage(key: string): Promise<number | null> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${key}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { data?: { usage?: number } }
    return typeof body.data?.usage === "number" ? body.data.usage : null
  } catch {
    return null
  }
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(cookie, path, init)
  expect(response.ok, `${path}: ${await response.clone().text()}`).toBe(true)
  return (await response.json()) as T
}

type Workspace = {
  site: { host: string | null; live: { version: number } | null }
  builds: { assignment_id: string; state: string }[]
  missing_facts: string[]
  reminders: {
    notes: { id: string; title: string; source: string }[]
  }
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" })

/**
 * Answers one question from the team in place: the price when it asks for
 * one, otherwise the first offered option or a line that changes nothing.
 */
async function answer(page: Page, item: Locator) {
  const title = await item.getByRole("heading").innerText()
  const price = item.getByLabel("Hourly price, in pounds")
  const text = item.getByLabel("Your answer")
  if (await price.count()) {
    await price.fill(PRICE.pounds)
  } else if (await text.count()) {
    await text.fill(
      /pric|charge|rate/i.test(title)
        ? `£${PRICE.pounds} an hour`
        : "Keep everything else as it is."
    )
  } else {
    await item.getByRole("radio").first().check()
  }
  await item.getByRole("button", { name: "Send answer" }).click()
  await expect(
    panel(page).getByRole("article", { name: title, exact: true })
  ).toHaveCount(0, { timeout: WAIT.chat })
}

/**
 * Waits for version `n`'s approval, answering any question the build asks
 * first, and approves it.
 */
async function approveVersion(page: Page, n: number) {
  const approve = panel(page).getByRole("button", {
    name: `Approve and publish v${n}`,
  })
  const question = panel(page).locator('[data-slot="question-item"]').first()
  const deadline = Date.now() + WAIT.approval
  // A guard against a build that asks forever.
  for (let asked = 0; asked < 5; asked++) {
    await expect(approve.or(question).first()).toBeVisible({
      timeout: Math.max(deadline - Date.now(), 1),
    })
    if (await approve.isVisible()) break
    await answer(page, question)
  }
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(panel(page).getByText(`Version ${n} is live.`)).toBeVisible({
    timeout: WAIT.publish,
  })
}

/** The live site answers 200 and shows each of `texts`. */
async function expectLive(page: Page, host: string, texts: string[]) {
  const site = await page.context().newPage()
  try {
    await expect(async () => {
      const response = await site.goto(`https://${host}/`)
      expect(response?.status()).toBe(200)
      for (const text of texts) {
        await expect(site.locator("body")).toContainText(text, {
          timeout: 5_000,
        })
      }
    }).toPass({ timeout: WAIT.publish, intervals: [5_000] })
  } finally {
    await site.close()
  }
}

test("@live the golden path: signup to v2 live, and cleared after", async ({
  page,
}) => {
  const began = Date.now()
  for (const [name, key] of openrouterKeys()) {
    run.openrouter_usage_usd[name] = {
      before: await keyUsage(key),
      after: null,
      delta: null,
    }
  }
  if (openrouterKeys().length === 0) {
    note("No OpenRouter key in the environment: the run's cost is unread.")
  }

  let onboarding = ""
  await step("sign up", async () => {
    user = await createProbeUser(`golden-${day}-`)
    await signIn(page, user)
    run.org_id = (await startOrg(page, user, run.business)).org_id
    cookie = await sessionCookie(page)
    await visit(page, "/app")
    await expect(page).toHaveURL(/\/app\/c\/[0-9a-f-]{36}$/)
    onboarding = page.url()
  })

  await step("blank state: continue getting started", async () => {
    // Only while nothing is built: the panel's first steps link back to
    // the onboarding conversation.
    await visit(page, "/app/notifications")
    await panel(page)
      .getByRole("link", { name: "Continue getting started" })
      .click()
    await expect(page).toHaveURL(onboarding)
    await expect(page.getByLabel("Business name")).toBeVisible()
    run.blank_state_actions["Continue getting started"] = "clicked"
  })

  await step("onboarding, pricing skipped, build accepted", async () => {
    const pending = page.locator('[data-slot="ask-fact"] form')
    const answered = page.locator('[data-slot="ask-fact"]:not(:has(form))')
    const card = page.locator('[data-slot="request-change"]')
    await expect(page.getByLabel("Business name")).toHaveValue(run.business)
    await pending.getByRole("button", { name: "Save" }).click()
    let count = 1
    await expect(answered).toHaveCount(count)
    // Six facts at most: a guard against a script that never ends.
    while (count < 7) {
      await expect(pending.or(card).first()).toBeVisible()
      if (await card.count()) break
      await expect(pending.locator("input").first()).toBeFocused()
      const question = await page
        .locator('[data-slot="ask-fact"]:has(form) p')
        .first()
        .innerText()
      const skip = pending.getByRole("button", { name: "Skip for now" })
      if (await skip.count()) {
        await skip.click()
      } else {
        const fill = ANSWERS[question]
        expect(fill, `no answer for "${question}"`).toBeDefined()
        await fill?.(pending)
        await pending.getByRole("button", { name: "Save" }).click()
      }
      count += 1
      await expect(answered).toHaveCount(count)
    }
    expect(count).toBe(6)
    await expect(card).toContainText("Build my website")
    await card.getByRole("button", { name: "Approve" }).click()
    await expect(card).toContainText("Started. Follow it under Working on.")
    await expect(
      panel(page).getByRole("heading", { name: "Working on" })
    ).toBeVisible()
  })

  await step("blank state: try again", async () => {
    // A failed read, made by failing the panel's poll (a GET server
    // function) until it shows. The action only renders while nothing
    // waits on the owner, so a question that arrived first means it is not
    // reachable on this run, and the run says so.
    const fail = (route: Route) =>
      route.request().method() === "GET" ? route.abort() : route.fallback()
    const stale = panel(page).getByText("This panel did not refresh.")
    const retry = panel(page).getByRole("button", { name: "Try again" })
    const question = panel(page).locator('[data-slot="question-item"]')
    await page.route("**/_serverFn/**", fail)
    try {
      await expect(stale.or(question).first()).toBeVisible()
    } finally {
      await page.unroute("**/_serverFn/**", fail)
    }
    if (!(await retry.isVisible())) {
      run.blank_state_actions["Try again"] =
        "not reached: a question was already waiting"
      note("Try again was not reachable: the pricing question came first.")
      return
    }
    await retry.click()
    await expect(stale).toHaveCount(0)
    run.blank_state_actions["Try again"] = "clicked"
  })

  await step("the build asks for the price, answered in place", async () => {
    const question = panel(page).locator('[data-slot="question-item"]').first()
    await expect(question).toBeVisible({ timeout: WAIT.question })
    expect(
      (await question.getByLabel("Hourly price, in pounds").count()) > 0 ||
        /pric|charge|rate/i.test(await question.innerText()),
      `the first question is not the price: ${await question.innerText()}`
    ).toBe(true)
    await answer(page, question)
  })

  let host = ""
  await step("v1 approved, live with the price", async () => {
    await approveVersion(page, 1)
    const workspace = await readJson<Workspace>("/workspace")
    expect(workspace.site.live?.version).toBe(1)
    host = workspace.site.host ?? ""
    expect(host, "the workspace names no host").not.toBe("")
    await expectLive(page, host, [PRICE.shown])
    await expect(
      panel(page)
        .getByRole("region", { name: "Your website" })
        .getByRole("img", {
          name: "Your website's home page on a laptop, version 1",
        })
    ).toBeVisible()
  })

  await step("blank state: see notifications", async () => {
    // Nothing waits on the owner once v1 is live, so "Waiting on you"
    // offers the notifications page, where v1's publish is listed.
    await panel(page).getByRole("link", { name: "See notifications" }).click()
    await expect(page).toHaveURL(/\/app\/notifications$/)
    await expect(
      page.getByRole("heading", { name: "Notifications", level: 1 })
    ).toBeVisible()
    await expect(page.locator('li[data-kind="report"]').first()).toBeVisible()
    run.blank_state_actions["See notifications"] = "clicked"
  })

  await step("a Chief of Staff change, approved to v2 live", async () => {
    // Nothing is new any more, so /app is a new chat, not onboarding.
    await visit(page, "/app")
    await expect(page).toHaveURL(/\/app\/?$/)
    await expect(page.getByRole("button", { name: "Mode, Act" })).toBeVisible()
    await page
      .getByLabel("Message input")
      .fill(`Change the hero to say "${HERO}"`)
    await page.getByLabel("Send message").click()
    const card = page.locator('[data-slot="request-change"]').last()
    await card
      .getByRole("button", { name: "Approve" })
      .click({ timeout: WAIT.chat })
    await expect(card).toContainText("Started. Follow it under Working on.")
    await expect(
      panel(page).getByRole("heading", { name: "Working on" })
    ).toBeVisible()
    await approveVersion(page, 2)
    await expectLive(page, host, [HERO, PRICE.shown])
  })

  await step("reminders from both sources, completed", async () => {
    const reminders = panel(page).getByRole("region", { name: "Reminders" })
    const status = reminders.getByRole("status")
    const noteOf = (title: string) =>
      reminders.locator('[data-slot="reminder-note"]', { hasText: title })
    /** The note's own Done, then the note gone from the list. */
    const complete = async (title: string) => {
      await reminders.getByRole("button", { name: `Done: ${title}` }).click()
      await expect(status).toHaveText("Marked done.")
      await expect(noteOf(title)).toHaveCount(0)
    }
    /** Which source the api recorded for the note, while it is open. */
    const sourceOf = async (title: string) =>
      (await readJson<Workspace>("/workspace")).reminders.notes.find(
        (each) => each.title === title
      )?.source

    // The owner's own, through the panel's form.
    const own = `Order more cloths ${token}`
    await reminders.getByLabel("Add a reminder").fill(own)
    await reminders.getByRole("button", { name: "Add reminder" }).click()
    await expect(status).toHaveText("Added to your reminders.")
    await expect(noteOf(own)).toBeVisible()
    await expect(noteOf(own)).not.toContainText("Set by Reme")
    expect(await sourceOf(own)).toBe("owner")
    await complete(own)

    // The Chief of Staff's, through "+" and its approval card.
    await page.getByRole("button", { name: "Quick actions" }).click()
    await page.getByRole("menuitem", { name: "Remind me" }).click()
    const input = page.getByLabel("Message input")
    await expect(input).toHaveValue("Remind me to ")
    await input.fill(
      `Remind me to ring the window cleaner about ${token} tomorrow at 10am`
    )
    await page.getByLabel("Send message").click()
    // The generic approval card: the tool has no card of its own yet.
    const card = page
      .getByRole("region", { name: "Approval needed: create_reminder" })
      .last()
    await card
      .getByRole("button", { name: "Approve" })
      .click({ timeout: WAIT.chat })
    await expect(page.getByText("You approved this.").last()).toBeVisible()
    // The title is the Chief of Staff's restatement, so it is found by the
    // run's token and then used whole.
    const set = noteOf(token)
    await expect(set).toContainText("Set by Reme", { timeout: WAIT.chat })
    await expect(set).toContainText("Due ")
    const setTitle = await set.locator("span").first().innerText()
    expect(await sourceOf(setTitle)).toBe("assistant")
    await complete(setTitle)
  })

  await step("the api's own reads of the run", async () => {
    const workspace = await readJson<Workspace>("/workspace")
    expect(workspace.site.live?.version).toBe(2)
    expect(workspace.builds).toEqual([])
    expect(workspace.missing_facts).toEqual([])

    const { facts } = await readJson<{ facts: { key: string }[] }>("/facts")
    expect(facts.map((fact) => fact.key).sort()).toEqual(
      expect.arrayContaining([
        "business.email",
        "business.name",
        "business.phone",
        "hours.weekday",
        "pricing.standard_clean_hourly",
        "service_area.radius",
      ])
    )

    const { items } = await readJson<{
      items: { kind: string; what?: string; revision?: { version: number } }[]
    }>("/activity")
    expect(
      items
        .filter((item) => item.kind === "report" && item.what === "published")
        .map((item) => item.revision?.version)
        .sort()
    ).toEqual([1, 2])

    const { staff } = await readJson<{ staff: unknown[] }>("/staff")
    expect(staff).toHaveLength(3)

    // No api reads staff history, so the hires are counted in Postgres,
    // read only, when the run is given staging's URL.
    const url = process.env.E2E_DATABASE_URL
    if (!url) {
      note("E2E_DATABASE_URL is unset: the staff.hired count is unchecked.")
      return
    }
    const sql = postgres(url, { max: 1 })
    try {
      const [row] = await sql<{ hires: number }[]>`
        select count(*)::int as hires from events
        where org_id = ${run.org_id} and type = 'staff.hired'`
      expect(row?.hires).toBe(3)
    } finally {
      await sql.end()
    }
  })

  run.total_seconds = Math.round((Date.now() - began) / 1000)
})

/**
 * Builds still open, stopped, so the probe cleanup (which refuses an org
 * with an unfinished assignment) can take the org.
 */
async function stopBuilds() {
  const read = async () =>
    ((await (await api(cookie, "/workspace")).json()) as Workspace).builds
  for (const build of await read()) {
    await api(cookie, `/builds/${build.assignment_id}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
  }
  await expect.poll(read, { timeout: 120_000 }).toEqual([])
}

test.afterAll(async () => {
  test.setTimeout(10 * 60_000)
  const failures: string[] = []

  // The key's usage lags the calls a little.
  if (openrouterKeys().length) {
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
  for (const [name, key] of openrouterKeys()) {
    const entry = run.openrouter_usage_usd[name]
    if (!entry) continue
    entry.after = await keyUsage(key)
    entry.delta =
      entry.before === null || entry.after === null
        ? null
        : Number((entry.after - entry.before).toFixed(6))
  }
  const record = JSON.stringify(run, null, 2)
  console.log(`golden run\n${record}`)
  await test.info().attach("golden-run.json", {
    body: record,
    contentType: "application/json",
  })

  if (!user) return
  // The org whole, every layer, by its id. WorkOS alone is the fallback:
  // when signup died before the org's id came back, or the clear refused,
  // in which case its Postgres rows stay for `pnpm probe:clear --org`.
  let cleared = false
  if (run.org_id) {
    try {
      if (cookie) await stopBuilds()
    } catch (error) {
      failures.push(`builds not stopped: ${error}`)
    }
    const clear = spawnSync(
      "pnpm",
      ["probe:clear", "--probe", run.org_id, "--yes"],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    )
    cleared = clear.status === 0
    if (!cleared) {
      failures.push(
        `pnpm probe:clear --probe ${run.org_id} exited ${clear.status}; its rows stay, clear them with --org`
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
  expect(failures, "the golden run left something behind").toEqual([])
})
