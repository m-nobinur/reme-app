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
  stopBuilds,
} from "./owner"
import { visit } from "./visit"
import { createProbeUser, PROBE_ORG_PREFIX, type ProbeUser } from "./workos"

/**
 * The golden path on staging, through the UI a new owner uses: signup,
 * onboarding, the first build, any question it asks answered in the panel,
 * v1 approved and live with its quote action and its thumbnail, the panel's blank-state actions, a Chief of Staff change to
 * v2 that keeps the quote link and form, a reminder from the chat shown and completed in the panel, and
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
 * A first build says it takes about 6 to 10 minutes, and a question can
 * arrive in its first minute. Each wait below is the top of that range with
 * room, and every one polls the page.
 */
const WAIT = {
  approval: 900_000,
  publish: 180_000,
  chat: 120_000,
}
test.setTimeout(50 * 60_000)

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
const RULE =
  "From now on, whenever you write or change a heading on my website, put it in capital letters"

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
 * Answers the questions the assistant asked, in the chat card the panel's
 * row opens: each page the first offered option or a line that changes
 * nothing, until the stack folds away.
 */
async function answer(page: Page, item: Locator) {
  await item.getByText("Answer", { exact: true }).click()
  const stack = page.locator('[data-slot="build-questions"]')
  const card = stack.locator('[data-slot="question-tray"]')
  const send = card.getByRole("button", { name: "Send", exact: true })
  const folded = stack.getByText("Thanks, that's everything I needed.")
  await expect(send).toBeVisible({ timeout: WAIT.chat })
  // A guard against a stack that never folds: at most ten questions.
  for (let left = 10; left > 0 && (await send.isVisible()); left--) {
    const text = card.locator(
      'input[name="answer"]:not([type="radio"]):visible'
    )
    if (await text.count()) {
      await text.fill("Keep everything else as it is.")
    } else {
      // Not now leaves the web address question for later.
      const later = card.getByRole("radio", { name: "Not now" })
      await ((await later.isVisible())
        ? later
        : card.locator('input[type="radio"]:visible').first()
      ).check()
    }
    await send.click()
    // The tick, then the next question on its own, or the fold.
    await expect(send).toHaveCount(0, { timeout: WAIT.chat })
    await expect(send.or(folded)).toBeVisible({ timeout: WAIT.chat })
  }
  await expect(stack).toHaveCount(0, { timeout: WAIT.chat })
}

/** Publish on the chat's ready card, or on the panel's review. */
const publishIn = {
  chat: (page: Page) =>
    page
      .locator('[data-slot^="site-ready"]')
      .getByRole("button", { name: "Publish", exact: true }),
  panel: (page: Page) =>
    panel(page)
      .locator('[data-slot="approval-item"]')
      .getByRole("button", { name: "Publish", exact: true }),
}

/**
 * Publishes the version waiting for review with `publish` and returns its
 * number, read from the api once it is live past `before`. Only a report that
 * passes the gates takes the site's next number (ADR-031), so the first
 * version is v1 even when a gate refused the build's first report.
 */
async function approveVersion(
  page: Page,
  publish: Locator,
  before: number
): Promise<number> {
  const question = panel(page).locator('[data-slot="question-item"]').first()
  const deadline = Date.now() + WAIT.approval
  // A guard against a build that asks forever.
  for (let asked = 0; asked < 5; asked++) {
    await expect(publish.or(question).first()).toBeVisible({
      timeout: Math.max(deadline - Date.now(), 1),
    })
    if (await publish.isVisible()) break
    await answer(page, question)
  }
  await expect(publish).toBeEnabled()
  await publish.click()
  // The site sits on the panel's Website tab, which appears once it is live.
  const website = panel(page).getByRole("tab", { name: "Website" })
  await expect(website).toBeVisible({ timeout: WAIT.publish })
  await website.click()
  await expect(
    panel(page)
      .getByRole("tabpanel")
      .getByText(/^Live (at \S+|now)$/)
  ).toBeVisible({ timeout: WAIT.publish })
  const version = async () =>
    (await readJson<Workspace>("/workspace")).site.live?.version ?? 0
  await expect
    .poll(version, { timeout: WAIT.publish, intervals: [5_000] })
    .toBeGreaterThan(before)
  return version()
}

/**
 * The live site's quote action: a link to /quote/, whatever its words, and
 * the form on that page. The site states no price, so this is the v1 content
 * a later change has to keep.
 */
async function expectQuote(page: Page, host: string) {
  const site = await page.context().newPage()
  try {
    await site.goto(`https://${host}/`)
    // By where it goes: its words are site copy the Developer may edit.
    const link = site.locator('a[href$="/quote/"], a[href$="/quote"]').first()
    await expect(link).toBeVisible()
    const response = await site.goto(`https://${host}/quote/`)
    expect(response?.status()).toBe(200)
    const form = site.locator("form.quote-form")
    await expect(form).toBeVisible()
    await expect(form.locator('button[type="submit"]')).toBeVisible()
  } finally {
    await site.close()
  }
}

/** The live site answers 200 and shows each of `texts`, as styled. */
async function expectLive(page: Page, host: string, texts: string[]) {
  const site = await page.context().newPage()
  try {
    await expect(async () => {
      const response = await site.goto(`https://${host}/`)
      expect(response?.status()).toBe(200)
      for (const text of texts) {
        await expect(site.locator("body")).toContainText(text, {
          timeout: 5_000,
          useInnerText: true,
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

  await step("blank state: finish setting up", async () => {
    // Only while nothing is built: on the Website page the panel's next
    // step links back to the onboarding conversation.
    await visit(page, "/app/website")
    const opener = panel(page).getByRole("button", { name: /open the panel$/ })
    if (await opener.isVisible()) await opener.click()
    await panel(page)
      .getByRole("list", { name: "Next steps" })
      .getByRole("link", { name: "Finish setting up" })
      .click()
    await expect(page).toHaveURL(onboarding)
    // The welcome is text only and asks what the business does; every
    // variant thanks the owner for choosing their business assistant.
    await expect(
      page.locator('[data-slot="aui_assistant-message-root"]').first()
    ).toContainText("business assistant")
    run.blank_state_actions["Finish setting up"] = "clicked"
  })

  await step("onboarding, build started", async () => {
    await answerOnboarding(page)
    // The design tray's answer started it, with no card to approve.
    await expect(page.locator('[data-slot="request-change"]')).toHaveCount(0)
  })

  await step("blank state: try again", async () => {
    // A failed read, made by failing the panel's poll (a GET server
    // function) until it shows. The action only renders on a section with
    // nothing in it, so a question or a build listed first means it is not
    // reachable on this run, and the run says so.
    const fail = (route: Route) =>
      route.request().method() === "GET" ? route.abort() : route.fallback()
    const stale = panel(page)
      .getByText("Couldn't refresh. Trying again in a minute.")
      .first()
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
        ? "not reached: the panel listed work, so it offered no Try again"
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

  let host = ""
  let first = 0
  let second = 0
  await step("v1 approved, live with the quote action", async () => {
    // From the chat's card, which then says the site is live.
    first = await approveVersion(page, publishIn.chat(page), 0)
    expect(first).toBe(1)
    const said = Date.now()
    await expect(
      page
        .locator('[data-slot="site-ready"]')
        .getByText("Published", { exact: true })
    ).toBeVisible({ timeout: WAIT.publish })
    note(
      `The chat said v1 is live ${Math.round((Date.now() - said) / 1000)} s after the panel did.`
    )
    const workspace = await readJson<Workspace>("/workspace")
    expect(workspace.site.live?.version).toBe(first)
    host = workspace.site.host ?? ""
    expect(host, "the workspace names no host").not.toBe("")
    await expectLive(page, host, [])
    await expectQuote(page, host)
    await expect(
      panel(page)
        .getByRole("tabpanel")
        .getByRole("img", { name: "Your website's home page on a laptop" })
    ).toBeVisible()
  })

  await step("blank state: see notifications", async () => {
    // The bell in the rail opens its menu, whose last entry is the
    // notifications page, where v1's publish is listed.
    await page.getByRole("button", { name: /^Notifications/ }).click()
    await page.getByRole("link", { name: "View all notifications" }).click()
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

  await step("a correction for the Developer, saved", async () => {
    // Nothing is new any more, so /app is a new chat, not onboarding.
    await visit(page, "/app")
    await expect(page).toHaveURL(/\/app\/?$/)
    await page.getByLabel("Message input").fill(RULE)
    await page.getByLabel("Send message").click()
    await expect(async () => {
      const { corrections } = await readJson<{
        corrections: { staff: string; text: string }[]
      }>("/memory")
      expect(corrections).toContainEqual(
        expect.objectContaining({ staff: "developer", text: RULE })
      )
    }).toPass({ timeout: WAIT.chat, intervals: [5_000] })
  })

  await step("a Chief of Staff change, approved to v2 live", async () => {
    await expect(page.getByLabel("Message input")).toBeVisible()
    await page
      .getByLabel("Message input")
      .fill(`Change the hero to say "${HERO}"`)
    // The owner's own words in Act mode start the change with no card.
    await page.getByLabel("Send message").click()
    second = await approveVersion(page, publishIn.panel(page), first)
    expect(second).toBe(first + 1)
    // The hero follows the owner's correction.
    await expectLive(page, host, [HERO.toUpperCase()])
    await expectQuote(page, host)
  })

  await step("a reminder from the chat, shown and completed", async () => {
    // Upcoming reminders sit on the panel's Reminders tab, which exists only
    // while there is one.
    const reminders = panel(page).getByRole("tabpanel")
    const noteOf = (title: string) =>
      reminders.locator('[data-slot="reminder-note"]', { hasText: title })
    /**
     * Which source the api recorded for the note, while it is open: found by
     * the run's token, since the panel capitalises the title the api holds.
     */
    const source = async () =>
      (await readJson<Workspace>("/workspace")).reminders.notes.find((each) =>
        each.title.includes(token)
      )?.source

    // The Chief of Staff's, through "+": the owner's own ask needs no card.
    await page.getByRole("button", { name: "Quick actions" }).click()
    await page.getByRole("menuitem", { name: "Remind me" }).click()
    const input = page.getByLabel("Message input")
    await expect(input).toHaveValue("Remind me to ")
    await input.fill(
      `Remind me to ring the window cleaner about ${token} tomorrow at 10am`
    )
    await page.getByLabel("Send message").click()
    await expect(
      page.locator('[data-slot="create-reminder"]').last()
    ).toContainText("Added to Reminders.", {
      timeout: WAIT.chat,
    })
    await panel(page)
      .getByRole("tab", { name: /^Reminders/ })
      .click({ timeout: WAIT.chat })
    // The title is the Chief of Staff's restatement, so it is found by the
    // run's token and then used whole.
    const set = noteOf(token)
    await expect(set).toContainText("Tomorrow", { timeout: WAIT.chat })
    const setTitle = await set.locator("span").first().innerText()
    expect(await source()).toBe("assistant")
    await reminders.getByRole("button", { name: `Done: ${setTitle}` }).click()
    // The last one done takes its tab with it.
    await expect(
      panel(page).getByRole("tab", { name: /^Reminders/ })
    ).toHaveCount(0)
  })

  await step("the api's own reads of the run", async () => {
    const workspace = await readJson<Workspace>("/workspace")
    expect(workspace.site.live?.version).toBe(second)
    expect(workspace.builds).toEqual([])
    expect(workspace.missing_facts).toEqual([])

    const { facts } = await readJson<{ facts: { key: string }[] }>("/facts")
    expect(facts.map((fact) => fact.key)).toEqual(
      expect.arrayContaining([
        "business.email",
        "business.industry",
        "business.name",
        "business.phone",
        "service_area.text",
        "assistant.name",
        "site.build_mode",
        "site.direction",
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

// Builds are stopped while the page and its live session are still open;
// the probe cleanup refuses an org with an unfinished build.
test.afterEach(async () => {
  if (owner)
    await stopBuilds(session).catch((error) =>
      note(`builds not stopped: ${error}`)
    )
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
      await stopBuilds(session)
    } catch (error) {
      failures.push(`builds not stopped: ${error}`)
    }
  }
  failures.push(...(await clearProbe(run.org_id, user)))
  expect(failures, "the golden run left something behind").toEqual([])
})
