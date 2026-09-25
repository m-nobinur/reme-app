/**
 * The development owner behind `pnpm dev:session`: who it is, the check that
 * it only ever lives in WorkOS staging, and the calls that make and unmake it.
 *
 * Plain ESM with the WorkOS client passed in, so the suite can drive every
 * branch with a stand-in and `scripts/preflight.mjs` can import it without a
 * build.
 */

/**
 * One documented account for every checkout. `example.net` because an SSO
 * connection on staging claims `example.com`, which answers `sso_required` to
 * any password (measured for the e2e suite, `qa/e2e/workos.ts`). The org name
 * says it is fictional (R8), and removal matches on it, so an org the owner was
 * added to by hand is never deleted.
 */
export const DEV_OWNER = {
  email: "owner+dev@example.net",
  firstName: "Dev",
  lastName: "Owner",
  orgName: "Dev Owner Cleaning (fictional)",
}

/**
 * Staging's AuthKit client, from `whoami` on the WorkOS MCP server. Public: it
 * travels in every sign-in URL.
 */
export const STAGING_CLIENT_ID = "client_01M0WWHM5TQAA6MDR2W910XA75"

/** A client on a Worker's `.dev.vars` values, imported late for preflight's sake. */
export async function client({ WORKOS_API_KEY, WORKOS_CLIENT_ID }) {
  const { WorkOS } = await import("@workos-inc/node")
  return new WorkOS(WORKOS_API_KEY, { clientId: WORKOS_CLIENT_ID })
}

/**
 * Why these credentials must not be used, or null when they are staging's.
 *
 * The client id alone proves nothing about the key, and the key is what every
 * write uses. So the key is put to WorkOS against staging's client id with a
 * code that cannot exist. Measured 2026-09-26: the staging key answers
 * `invalid_grant`, and the same key against the production client id answers
 * `invalid_client`, "a client secret from a different environment". Nothing is
 * created either way. Anything but `invalid_grant` refuses, so a network
 * failure stops the run rather than waving it through.
 */
export async function stagingRefusal({ clientId, apiKey }, fetcher = fetch) {
  if (clientId !== STAGING_CLIENT_ID) {
    return `WORKOS_CLIENT_ID is not staging's (${STAGING_CLIENT_ID}).`
  }
  if (!apiKey) return "WORKOS_API_KEY is empty."
  let answer = "no answer"
  try {
    const response = await fetcher(
      "https://api.workos.com/user_management/authenticate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: apiKey,
          grant_type: "authorization_code",
          code: "dev-session-environment-probe",
        }),
      }
    )
    const body = await response.json().catch(() => ({}))
    if (body.error === "invalid_grant") return null
    answer = `${response.status} ${body.error ?? ""}`.trim()
  } catch (error) {
    answer = error instanceof Error ? error.message : String(error)
  }
  return `WORKOS_API_KEY is not staging's key: WorkOS answered ${answer}.`
}

/**
 * The owner, created on the first run and found on every run after, with a
 * password that exists only for this run. Nothing stores it: the next run sets
 * a new one, so no credential outlives the process.
 *
 * `emailVerified` because the address receives no mail, and without it the
 * sign-in stops at `email_verification_required`.
 */
export async function ensureOwner(workos, password) {
  const users = workos.userManagement
  const [found] = (await users.listUsers({ email: DEV_OWNER.email })).data
  if (found) {
    await users.updateUser({ userId: found.id, password })
    return { user: found, created: false }
  }
  const user = await users.createUser({
    email: DEV_OWNER.email,
    password,
    firstName: DEV_OWNER.firstName,
    lastName: DEV_OWNER.lastName,
    emailVerified: true,
  })
  return { user, created: true }
}

/**
 * Deletes the owner and the organizations `createOrg` made for it, and
 * returns what went. Nothing there is a no-op, so it is safe to run twice.
 */
export async function removeOwner(workos) {
  const users = workos.userManagement
  const [user] = (await users.listUsers({ email: DEV_OWNER.email })).data
  if (!user) return { userId: null, orgIds: [] }
  const memberships = await users.listOrganizationMemberships({
    userId: user.id,
  })
  const orgIds = memberships.data
    .filter((m) => m.organizationName === DEV_OWNER.orgName)
    .map((m) => m.organizationId)
  for (const id of orgIds) await workos.organizations.deleteOrganization(id)
  await users.deleteUser(user.id)
  return { userId: user.id, orgIds }
}

/**
 * What `preflight` says about a stored session: `valid`, `unsealable` (sealed
 * with a cookie password this checkout no longer has, so every page answers
 * as signed out), or `ended` (revoked, expired, or its user deleted).
 *
 * `valid` does not mean the access token is fresh. It lives five minutes and
 * the web app refreshes it on the next request, so the question is whether
 * the WorkOS session behind it is still active.
 */
export async function sessionStatus(workos, sealed, cookiePassword) {
  const users = workos.userManagement
  const data = await users.getSessionFromCookie({
    sessionData: sealed,
    cookiePassword,
  })
  if (!data?.accessToken) return "unsealable"
  const claims = JSON.parse(
    Buffer.from(data.accessToken.split(".")[1] ?? "", "base64url").toString()
  )
  try {
    const sessions = await users.listSessions(data.user.id)
    const live = sessions.data.find((s) => s.id === claims.sid)
    return live?.status === "active" ? "valid" : "ended"
  } catch (error) {
    if (error.status === 404) return "ended"
    throw error
  }
}
