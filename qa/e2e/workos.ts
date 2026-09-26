import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The throwaway sign-in account the suite runs as.
 *
 * Staging WorkOS holds no users by standing instruction, with one exception:
 * one development owner per developer, `owner+dev-*@example.net`, made by
 * `pnpm dev:session` and removed with `pnpm dev:session --delete`. This suite
 * owns no permanent account. It creates one address per run and deletes it in
 * the teardown project. That is also what keeps the sign-in rate limiter out of
 * the way. The limiter is five attempts per address per sixty seconds, keyed on
 * the folded address (apps/web/src/lib/auth/throttle.ts), so a suite reusing one
 * account would burn a shared bucket and fail on the sixth run of the minute. A
 * fresh address per run starts on an empty bucket, which is the only mitigation
 * that neither weakens the limit nor makes the suite time-dependent.
 *
 * Plain `fetch` rather than `@workos-inc/node`: two calls, and a browser suite
 * has no reason to carry the server SDK.
 */

const API = "https://api.workos.com"

/**
 * Distinctive enough that the reaper below cannot mistake another agent's probe
 * user for one of ours, and vice versa.
 */
const PREFIX = "qa-e2e-"

/**
 * The name every probe organisation starts with, so the reaper can find one
 * a crashed `@live` run left behind. Its date follows.
 */
export const PROBE_ORG_PREFIX = "QA probe cleaning "
const DOMAIN = "example.net"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Both hold a live credential, so both are gitignored. */
export const STORAGE_STATE = join(HERE, ".auth/state.json")
const CREATED = join(HERE, ".auth/created.json")

function apiKey(): string {
  const key = process.env.WORKOS_API_KEY
  if (!key) {
    throw new Error(
      "WORKOS_API_KEY is not set. Locally it comes from .env.local; in CI from the environment's secrets."
    )
  }
  return key
}

async function call(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...init.headers,
    },
  })
  const text = await response.text()
  return {
    status: response.status,
    // A 204 and an error page both have no JSON body, and neither should throw
    // here, because the caller decides what a status means.
    body: parsed(text),
  }
}

/** A body as JSON, or empty: an organisation delete answers 202 "Accepted". */
function parsed(text: string): Record<string, unknown> {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type ProbeUser = { id: string; email: string; password: string }

/**
 * A verified account with a password, ready to sign in.
 *
 * `example.com` is not usable here. An SSO connection on the staging
 * environment claims that domain, so `authenticateWithPassword` answers
 * `sso_required` and no password ever works. `example.net` is unclaimed.
 *
 * The password is generated per run and never written to disk. Only the id is
 * persisted, and only so the teardown can delete an account whose creation
 * outlived the test that made it.
 */
export async function createProbeUser(label = ""): Promise<ProbeUser> {
  const email = `${PREFIX}${label}${crypto.randomUUID()}@${DOMAIN}`
  // 32 hex characters. Long enough to clear any password policy without
  // encoding an assumption about which one the environment has.
  const password = `Qa${crypto.randomUUID().replaceAll("-", "")}!`

  const created = await call("/user_management/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      first_name: "Probe",
      last_name: "Runner",
      // Without this the first sign-in answers `email_verification_required`
      // and stops on /verify-email instead of reaching the app.
      email_verified: true,
    }),
  })
  if (created.status !== 201) {
    throw new Error(
      `WorkOS refused the probe user: ${created.status} ${JSON.stringify(created.body)}`
    )
  }

  const id = created.body.id as string
  remember(id)
  return { id, email, password }
}

/** Ids are appended, so a retried setup still leaves nothing behind. */
function remember(id: string): void {
  mkdirSync(dirname(CREATED), { recursive: true })
  writeFileSync(CREATED, JSON.stringify([...rememberedIds(), id]))
}

export function rememberedIds(): string[] {
  try {
    return JSON.parse(readFileSync(CREATED, "utf8")) as string[]
  } catch {
    return []
  }
}

export function forgetIds(): void {
  writeFileSync(CREATED, "[]")
}

/** True once the account is gone, checked rather than assumed. */
export async function deleteProbeUser(id: string): Promise<boolean> {
  await call(`/user_management/users/${id}`, { method: "DELETE" })
  // Read back a few times: a user read straight after its delete can still
  // answer 200 for a moment.
  for (let tries = 0; tries < 5; tries++) {
    const after = await call(`/user_management/users/${id}`)
    if (after.status === 404) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/**
 * The WorkOS organisations an account belongs to, deleted. Its rows in our
 * database stay: the app cannot delete tenant rows.
 */
export async function deleteProbeOrgs(userId: string): Promise<void> {
  const listed = await call(
    `/user_management/organization_memberships?user_id=${userId}`
  )
  if (listed.status !== 200) {
    throw new Error(
      `WorkOS did not list ${userId}'s organisations: ${listed.status} ${JSON.stringify(listed.body)}`
    )
  }
  const memberships = (listed.body.data ?? []) as { organization_id: string }[]
  for (const { organization_id } of memberships) {
    const deleted = await call(`/organizations/${organization_id}`, {
      method: "DELETE",
    })
    if (deleted.status >= 300 && deleted.status !== 404) {
      throw new Error(`WorkOS kept ${organization_id}: ${deleted.status}`)
    }
  }
}

/**
 * Accounts a crashed run left behind.
 *
 * Only ours, by prefix, and only ones old enough that no run in flight could
 * still be using them. A suite running beside this one must not have its user
 * deleted mid-sign-in.
 */
export async function staleProbeUsers(): Promise<string[]> {
  const listed = await call("/user_management/users?limit=100")
  const users = (listed.body.data ?? []) as {
    id: string
    email: string
    created_at: string
  }[]
  const anHourAgo = Date.now() - 60 * 60 * 1000
  return users
    .filter((user) => user.email.startsWith(PREFIX))
    .filter((user) => Date.parse(user.created_at) < anHourAgo)
    .map((user) => user.id)
}

/**
 * Organisations a crashed `@live` run left behind: its own `finally` never
 * ran, so nothing deleted them. By name prefix and an hour's age, like the
 * users above, and deleted. Their rows in our database stay.
 */
export async function reapProbeOrgs(): Promise<string[]> {
  const listed = await call("/organizations?limit=100")
  if (listed.status !== 200) {
    throw new Error(
      `WorkOS did not list organisations: ${listed.status} ${JSON.stringify(listed.body)}`
    )
  }
  const orgs = (listed.body.data ?? []) as {
    id: string
    name: string
    created_at: string
  }[]
  const anHourAgo = Date.now() - 60 * 60 * 1000
  const stale = orgs.filter(
    (org) =>
      org.name.startsWith(PROBE_ORG_PREFIX) &&
      Date.parse(org.created_at) < anHourAgo
  )
  for (const org of stale) {
    const deleted = await call(`/organizations/${org.id}`, { method: "DELETE" })
    if (deleted.status >= 300 && deleted.status !== 404) {
      throw new Error(`WorkOS kept ${org.id}: ${deleted.status}`)
    }
  }
  return stale.map((org) => org.id)
}
