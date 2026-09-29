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

/** A fictional number in Ofcom's drama range. */
const PHONE = "+447700900123"

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
  expect(workspace.site).toEqual({ host: null, live: null })
  expect(workspace.builds).toEqual([])
  expect(workspace.missing_facts).not.toContain("business.phone")
  expect(workspace.missing_facts.length).toBeGreaterThan(0)

  // The name signup collected, and the phone set above.
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
    ])
  )
  expect(facts).toHaveLength(2)

  // The feed shows publishes and rollbacks, and this org has neither.
  expect(await read("/activity")).toEqual({ items: [] })

  // A new owner lands in onboarding, with the org's own first steps beside it.
  await visit(page, "/app")
  await expect(page).toHaveURL(/\/app\/c\/[0-9a-f-]{36}$/)
  await expect(page.getByRole("combobox")).toContainText(name)
  const steps = panel(page)
    .getByRole("region", { name: "First steps" })
    .getByRole("listitem")
  await expect(steps).toHaveCount(workspace.missing_facts.length + 1)
  await expect(steps.last()).toHaveText("To do: Build your first version")
  await expect(steps.filter({ hasText: "Phone number" })).toHaveCount(0)

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
    main.getByRole("definition").filter({ hasText: PHONE })
  ).toBeVisible()
  await expect(main.getByText(/^You told Reme/)).toHaveCount(2)
})
