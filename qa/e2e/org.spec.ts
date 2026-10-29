import { expect, type Page, test } from "@playwright/test"
import { api, clearProbe, sessionCookie, signIn, startOrg } from "./owner"
import { visit } from "./visit"
import { createProbeUser, PROBE_ORG_PREFIX, type ProbeUser } from "./workos"

/**
 * An owner with an organisation, in the blocking smoke. The other specs run
 * as an owner with none, which is what their cross-tenant checks need; this
 * one makes an org the way signup does, states one fact, reads it back
 * through `apps/api` and the app, and clears the org whole with
 * `pnpm probe:clear`, pass or fail. No build: that is the paid `@live` path.
 *
 * The org is unique to the run and named as a probe, so two runs against the
 * staging database do not collide, and a run that dies before its clear is
 * reaped by name and age.
 *
 * `@probe-org`, because `probe:clear` is staging-only (ADR-032): the
 * production smoke leaves this out by that tag. Local `pnpm dev` reads its
 * own Postgres, which the clear cannot reach, so it is skipped there too.
 * Anywhere else the clear's credentials are required, and a run without them
 * fails rather than skips.
 */

test.use({ storageState: { cookies: [], origins: [] } })

const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000")
test.skip(
  base.hostname === "preview.remeai.co.uk",
  "production: pnpm probe:clear is staging-only (ADR-032)"
)
test.skip(
  base.hostname === "localhost",
  "local dev reads its own Postgres, which pnpm probe:clear cannot reach"
)

const CLEAR_NEEDS = [
  "NEON_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "WORKOS_CLIENT_ID",
]

/** A fictional number in Ofcom's drama range, and as the profile writes it. */
const PHONE = "+447700900123"
const PHONE_SHOWN = "07700 900123"

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

// Two sign-ins, three api reads and three pages against a cold preview: the
// default 60 s ran out on the gate's first run.
test.setTimeout(3 * 60_000)

/** The panel beside the conversation, by its landmark name. */
const panel = (page: Page) => page.getByRole("complementary", { name: "Panel" })

test("an owner with an org sees its team and the fact it stated @probe-org", async ({
  page,
}) => {
  expect(
    CLEAR_NEEDS.filter((key) => !process.env[key]),
    "pnpm probe:clear cannot run without these, so no org is made"
  ).toEqual([])

  const day = new Date().toISOString().slice(0, 10)
  const name = `${PROBE_ORG_PREFIX}${day} smoke ${crypto.randomUUID().slice(0, 8)}`
  user = await createProbeUser("org-")
  await signIn(page, user)
  orgId = (await startOrg(page, user, name)).org_id

  const set = await api(await sessionCookie(page), "/facts", {
    method: "POST",
    headers: { "idempotency-key": `facts:${user.id}` },
    body: JSON.stringify({
      facts: [{ key: "business.phone", value: { e164: PHONE } }],
    }),
  })
  expect(set.status, await set.clone().text()).toBe(200)

  const read = async (path: string) => {
    const response = await api(await sessionCookie(page), path)
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(
      200
    )
    return response.json()
  }

  // Nothing built, so no host and nothing live; the fact is no longer asked for.
  const workspace = await read("/workspace")
  expect(workspace.site).toEqual({ host: null, url: null, live: null })
  expect(workspace.builds).toEqual([])
  expect(workspace.missing_facts).not.toContain("business.phone")
  expect(workspace.missing_facts.length).toBeGreaterThan(0)

  // The names signup collected, and the phone set above.
  const { facts } = await read("/facts")
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        org_id: orgId,
        key: "business.name",
        value: { name },
      }),
      expect.objectContaining({
        org_id: orgId,
        key: "business.phone",
        value: { e164: PHONE },
      }),
      expect.objectContaining({ org_id: orgId, key: "owner.preferred_name" }),
    ])
  )
  expect(facts).toHaveLength(3)

  // The feed shows publishes and rollbacks, and this org has neither.
  expect(await read("/activity")).toEqual({ items: [] })

  // A new owner lands in onboarding, with the org's own first steps beside it.
  await visit(page, "/app")
  await expect(page).toHaveURL(/\/app\/c\/[0-9a-f-]{36}$/)
  // The panel beside it, with no link to the chat the owner is in.
  await expect(panel(page)).toBeVisible()
  await expect(
    panel(page).getByRole("link", { name: "Finish setting up" })
  ).toHaveCount(0)

  // The starting team: the owner, the Chief of Staff and the Developer.
  await visit(page, "/app/staff")
  const rows = page.getByRole("table").locator("tbody tr")
  await expect(rows).toHaveCount(3)
  for (const code of ["OWN-001", "COS-001", "DEV-001"]) {
    await expect(rows.filter({ hasText: code })).toHaveCount(1)
  }

  // The fact on the profile, as the owner's own.
  await visit(page, "/app/profile")
  await expect(
    page.getByRole("heading", { name, exact: true, level: 1 })
  ).toBeVisible()
  const main = page.getByRole("main")
  await expect(
    main.getByRole("definition").filter({ hasText: PHONE_SHOWN })
  ).toBeVisible()
  // The name and the phone at least; the first name signup kept may show too.
  await expect
    .poll(() => main.getByText(/^You said this/).count())
    .toBeGreaterThanOrEqual(2)

  // A typed turn sends the turn and nothing else: no history, system prompt
  // or tools leave the browser, because the server reads its own rows. Each
  // request is caught here and never sent on, so no model runs and nothing
  // is written. Only the typed one is read: the chat may ask for its opener.
  await visit(page, "/app")
  const sent: (Record<string, unknown> & { turn?: { kind?: string } })[] = []
  await page.route("**/api/chat", async (route) => {
    sent.push(route.request().postDataJSON())
    await route.abort()
  })
  await page.getByLabel("Message input").fill("How did this week go?")
  await page.getByLabel("Send message").click()
  const typed = () => sent.find((each) => each.turn?.kind === "message")
  await expect.poll(typed).toBeDefined()
  const body = typed() ?? {}
  expect(Object.keys(body).sort()).toEqual([
    "conversation_id",
    "mode",
    "time_zone",
    "turn",
  ])
  expect(body.mode).toBe("act")
  expect(body.time_zone).toMatch(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/)
  expect(body.turn).toMatchObject({
    kind: "message",
    text: "How did this week go?",
  })
  await page.unroute("**/api/chat")
})
