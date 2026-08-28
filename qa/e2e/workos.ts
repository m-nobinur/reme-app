import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The throwaway sign-in account the suite runs as.
 *
 * Staging WorkOS is kept at zero users by standing instruction, so this suite
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
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
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
export async function createProbeUser(): Promise<ProbeUser> {
  const email = `${PREFIX}${crypto.randomUUID()}@${DOMAIN}`
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
  const after = await call(`/user_management/users/${id}`)
  return after.status === 404
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
