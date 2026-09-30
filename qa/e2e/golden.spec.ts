import {
  expect as baseExpect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test"
import postgres from "postgres"
import {
  answerOnboarding,
  api,
  clearProbe,
  sessionCookie,
  signIn,
  startOrg,
} from "./owner"
import { visit } from "./visit"
import { createProbeUser, PROBE_ORG_PREFIX, type ProbeUser } from "./workos"

/**
 * The golden path on staging, through the UI a new owner uses: signup,
 * onboarding with pricing skipped, the first build, its pricing question
 * answered in the panel, v1 approved and live with the price and its
 * thumbnail, the panel's blank-state actions, a Chief of Staff change to
 * v2, a reminder from the chat shown and completed in the panel, and
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
let owner: Page | null = null

/**
 * The owner's session as the browser holds it now. The web refreshes the
 * sealed session as the panel polls, so a cookie read once at sign-in is
 * stale within minutes and the api answers `session.absent`.
 */
async function session(): Promise<string> {
  if (!owner) throw new Error("no owner is signed in")
  try {
    lastSession = await sessionCookie(owner)
  } catch {
    // The page is closed by teardown time; the last cookie read is the best left.
  }
  return lastSession
}
let lastSession = ""

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

/**
 * A key's usage once the run's calls have landed on it: it lags them a
 * little. Read every 5 s until it has moved past `before` and two reads
 * agree, or a minute has passed, when the last read stands.
 */
async function settledUsage(
  key: string,
  before: number | null
): Promise<number | null> {
  let last: number | null = null
  for (let tries = 0; tries < 12; tries++) {
    const now = await keyUsage(key)
    if (now !== null && now === last && (before === null || now > before)) {
      return now
    }
    last = now
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return last
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(await session(), path, init)
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
  // The site sits on the panel's Website tab, which appears once it is live.
  const website = panel(page).getByRole("tab", { name: "Website" })
  await expect(website).toBeVisible({ timeout: WAIT.publish })
  await website.click()
  await expect(panel(page).getByText(`Version ${n} is live`)).toBeVisible({
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
    owner = page
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
    await expect(page.getByLabel("Phone number")).toBeVisible()
    run.blank_state_actions["Continue getting started"] = "clicked"
  })

  await step("onboarding, pricing skipped, build accepted", async () => {
    await answerOnboarding(page)
    const card = page.locator('[data-slot="request-change"]')
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
    let shown = false
    try {
      // A queued build polls every 30 s (open item 97), so the first failed
      // read can land half a minute in; a question arriving first is the same
      // "not reached".
      shown = await stale
        .or(question)
        .first()
        .waitFor({ timeout: 70_000 })
        .then(() => true)
        .catch(() => false)
    } finally {
      await page.unroute("**/_serverFn/**", fail)
    }
    if (!shown || !(await retry.isVisible())) {
      run.blank_state_actions["Try again"] = shown
        ? "not reached: a question was already waiting"
        : "not reached: the failed poll did not show within 70 s"
      note(
        `Try again was not reachable (${run.blank_state_actions["Try again"]}).`
      )
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
      panel(page).getByRole("tabpanel").getByRole("img", {
        name: "Your website's home page on a laptop, version 1",
      })
    ).toBeVisible()
  })

  await step("blank state: see notifications", async () => {
    // The bell at the top right opens the notifications page, where v1's
    // publish is listed.
    await page
      .getByRole("banner")
      .getByRole("link", { name: /^Notifications/ })
      .click()
    await expect(page).toHaveURL(/\/app\/notifications$/)
    await expect(
      page.getByRole("heading", { name: "Notifications", level: 1 })
    ).toBeVisible()
    // The publish report is written when the deployment is recorded, which
    // can trail the live host answering; reload as an owner would.
    const report = page.locator('li[data-kind="report"]').first()
    const listed = Date.now()
    await expect(async () => {
      if (!(await report.isVisible())) await page.reload()
      await expect(report).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 180_000, intervals: [5_000] })
    const waited = Math.round((Date.now() - listed) / 1000)
    if (waited > 5)
      note(
        `v1's publish report was listed ${waited} s after the site was live.`
      )
    run.blank_state_actions["See notifications"] = "clicked"
  })

  await step("a Chief of Staff change, approved to v2 live", async () => {
    // Nothing is new any more, so /app is a new chat, not onboarding.
    await visit(page, "/app")
    await expect(page).toHaveURL(/\/app\/?$/)
    await expect(page.getByLabel("Message input")).toBeVisible()
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

  await step("a reminder from the chat, shown and completed", async () => {
    // Upcoming reminders sit on the panel's Reminders tab, which exists only
    // while there is one.
    const reminders = panel(page).getByRole("tabpanel")
    const noteOf = (title: string) =>
      reminders.locator('[data-slot="reminder-note"]', { hasText: title })
    /** Which source the api recorded for the note, while it is open. */
    const sourceOf = async (title: string) =>
      (await readJson<Workspace>("/workspace")).reminders.notes.find(
        (each) => each.title === title
      )?.source

    // The Chief of Staff's, through "+" and its approval card.
    await page.getByRole("button", { name: "Quick actions" }).click()
    await page.getByRole("menuitem", { name: "Remind me" }).click()
    const input = page.getByLabel("Message input")
    await expect(input).toHaveValue("Remind me to ")
    await input.fill(
      `Remind me to ring the window cleaner about ${token} tomorrow at 10am`
    )
    await page.getByLabel("Send message").click()
    const card = page.locator('[data-slot="create-reminder"]').last()
    await card
      .getByRole("button", { name: "Add reminder" })
      .click({ timeout: WAIT.chat })
    await expect(card).toContainText("Added to Reminders.", {
      timeout: WAIT.chat,
    })
    await panel(page)
      .getByRole("tab", { name: /^Reminders/ })
      .click({ timeout: WAIT.chat })
    // The title is the Chief of Staff's restatement, so it is found by the
    // run's token and then used whole.
    const set = noteOf(token)
    await expect(set).toContainText("Set by Reme", { timeout: WAIT.chat })
    await expect(set).toContainText("Tomorrow")
    const setTitle = await set.locator("span").first().innerText()
    expect(await sourceOf(setTitle)).toBe("assistant")
    await reminders.getByRole("button", { name: `Done: ${setTitle}` }).click()
    // The last one done takes its tab with it.
    await expect(
      panel(page).getByRole("tab", { name: /^Reminders/ })
    ).toHaveCount(0)
  })

  await step("the api's own reads of the run", async () => {
    const workspace = await readJson<Workspace>("/workspace")
    expect(workspace.site.live?.version).toBe(2)
    expect(workspace.builds).toEqual([])
    expect(workspace.missing_facts).toEqual([])

    const { facts } = await readJson<{ facts: { key: string }[] }>("/facts")
    expect(facts.map((fact) => fact.key)).toEqual(
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
        .map((item) => item.revision?.version ?? 0)
        .sort((a, b) => a - b)
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
    (
      (await (
        await api(await session(), "/workspace")
      ).json()) as Partial<Workspace>
    ).builds ?? []
  for (const build of await read()) {
    await api(await session(), `/builds/${build.assignment_id}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
  }
  await expect.poll(read, { timeout: 120_000 }).toEqual([])
}

// Builds are stopped while the page and its live session are still open;
// the probe cleanup refuses an org with an unfinished build.
test.afterEach(async () => {
  if (owner)
    await stopBuilds().catch((error) => note(`builds not stopped: ${error}`))
})

test.afterAll(async () => {
  test.setTimeout(10 * 60_000)
  const failures: string[] = []

  await Promise.all(
    openrouterKeys().map(async ([name, key]) => {
      const entry = run.openrouter_usage_usd[name]
      if (!entry) return
      entry.after = await settledUsage(key, entry.before)
      entry.delta =
        entry.before === null || entry.after === null
          ? null
          : Number((entry.after - entry.before).toFixed(6))
    })
  )
  const record = JSON.stringify(run, null, 2)
  console.log(`golden run\n${record}`)
  await test.info().attach("golden-run.json", {
    body: record,
    contentType: "application/json",
  })

  if (!user) return
  if (run.org_id && owner) {
    try {
      await stopBuilds()
    } catch (error) {
      failures.push(`builds not stopped: ${error}`)
    }
  }
  failures.push(...(await clearProbe(run.org_id, user)))
  expect(failures, "the golden run left something behind").toEqual([])
})
