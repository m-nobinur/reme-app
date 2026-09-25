/**
 * The development owner behind `pnpm dev:session`: who it is, the check that
 * it only ever lives in WorkOS staging, and the calls that make and unmake it.
 *
 * Plain ESM with the WorkOS client passed in, so the suite can drive every
 * branch with a stand-in and `scripts/preflight.mjs` can import it without a
 * build.
 */
import { createHash } from "node:crypto"

/**
 * The development owner for one developer, named from their git address so two
 * developers never share an account, a password or an org. `example.net`
 * because an SSO connection on staging claims `example.com`, which answers
 * `sso_required` to any password (measured for the e2e suite,
 * `qa/e2e/workos.ts`). The org name says it is fictional (R8), and removal
 * matches on it, so an org the owner was added to by hand is never deleted.
 */
export function devOwner(gitEmail) {
  const who = String(gitEmail ?? "")
    .trim()
    .toLowerCase()
  if (!who) {
    throw new Error(
      "no git address to name the development owner from. Set `git config user.email`."
    )
  }
  const tag = createHash("sha256").update(who).digest("hex").slice(0, 8)
  return {
    email: `owner+dev-${tag}@example.net`,
    firstName: "Dev",
    lastName: "Owner",
    orgName: `Dev Owner ${tag} Cleaning (fictional)`,
  }
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
export async function ensureOwner(workos, owner, password) {
  const users = workos.userManagement
  const [found] = (await users.listUsers({ email: owner.email })).data
  if (found) {
    await users.updateUser({ userId: found.id, password })
    return { user: found, created: false }
  }
  const user = await users.createUser({
    email: owner.email,
    password,
    firstName: owner.firstName,
    lastName: owner.lastName,
    emailVerified: true,
  })
  return { user, created: true }
}

/**
 * Why the owner's memberships cannot be used, or null. None is a first run.
 * Two make WorkOS answer the password with `organization_selection_required`,
 * and one this script did not make would be adopted by `POST /org` as the
 * owner's business, so both stop the run and say which orgs they are.
 */
export function membershipRefusal(memberships, owner) {
  if (memberships.length === 0) return null
  if (
    memberships.length === 1 &&
    memberships[0].organizationName === owner.orgName
  ) {
    return null
  }
  const names = memberships.map((m) => `"${m.organizationName}"`).join(", ")
  return (
    `${owner.email} belongs to ${memberships.length} organization${memberships.length === 1 ? "" : "s"} (${names}) ` +
    `and needs to belong to "${owner.orgName}" alone. Remove it from the others, or \`pnpm dev:session --delete\`.`
  )
}

/**
 * Deletes the owner and the organizations `createOrg` made for it, and
 * returns what went. Nothing there is a no-op, so it is safe to run twice.
 */
export async function removeOwner(workos, owner) {
  const users = workos.userManagement
  const [user] = (await users.listUsers({ email: owner.email })).data
  if (!user) return { userId: null, orgIds: [] }
  const memberships = await users.listOrganizationMemberships({
    userId: user.id,
  })
  const orgIds = memberships.data
    .filter((m) => m.organizationName === owner.orgName)
    .map((m) => m.organizationId)
  for (const id of orgIds) await workos.organizations.deleteOrganization(id)
  await users.deleteUser(user.id)
  return { userId: user.id, orgIds }
}

/**
 * `--delete`: the local mirror first, then WorkOS. The local clear is the one
 * that can fail on a foreign key, and failing there leaves the owner whole in
 * both places to try again; the other order leaves a mirror of a user WorkOS
 * no longer has, which `createOrg` then trips on.
 */
export async function deleteOwner(workos, owner, clearLocal) {
  const local = await clearLocal()
  const remote = await removeOwner(workos, owner)
  return { local, remote }
}

/** The WorkOS session an access token belongs to, from its `sid` claim. */
export function sessionIdOf(accessToken) {
  const payload = accessToken.split(".")[1] ?? ""
  return JSON.parse(Buffer.from(payload, "base64url").toString()).sid
}

/**
 * Ends the session a previous run stored, so runs do not pile up live
 * sessions. Only this owner's: a file written for someone else is left alone.
 * `gone` when WorkOS had already ended it.
 */
export async function retireSession(workos, previous, userId) {
  if (!previous?.sessionId || previous.userId !== userId) return "none"
  try {
    await workos.userManagement.revokeSession({
      sessionId: previous.sessionId,
    })
    return "revoked"
  } catch {
    return "gone"
  }
}

const HEALTH_KEYS = ["status", "role", "bypasses_rls", "rows_for_absent_org"]

/**
 * What answers where `web` or `api` should: `absent`, `ours`, or `foreign`,
 * plus `unhealthy` for an api whose `/health` report is not `ok`.
 *
 * The web page served by Vite in development links its styles by absolute
 * path, so this checkout's web is the one whose page names this checkout's
 * root. Another checkout's web seals with another cookie password, and every
 * page there reads as signed out. The api is known by its health report.
 */
export async function appOn(app, url, root, fetcher = fetch) {
  let response
  try {
    response = await fetcher(app === "api" ? `${url}/health` : url, {
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return "absent"
  }
  if (app === "web") {
    const html = await response.text()
    return html.includes("<title>Reme</title>") && html.includes(`/@fs${root}/`)
      ? "ours"
      : "foreign"
  }
  const report = await response.json().catch(() => null)
  if (!report || !HEALTH_KEYS.every((key) => key in report)) return "foreign"
  return report.status === "ok" ? "ours" : "unhealthy"
}

const PORTS = { web: 3000, api: 3001 }

/** Which of the two to start, or why neither can be trusted. */
export function startPlan(found) {
  const wrong = Object.entries(found).filter(
    ([, state]) => state !== "absent" && state !== "ours"
  )
  if (wrong.length > 0) {
    const [app, state] = wrong[0]
    const why =
      state === "unhealthy"
        ? "answers /health with a failing report"
        : app === "web"
          ? "is not this checkout's web"
          : "is not the api"
    return {
      refusal: `port ${PORTS[app]} ${why}. Stop whatever holds it, then run this again.`,
    }
  }
  return {
    start: ["web", "api"].filter((app) => found[app] === "absent"),
  }
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
  const sid = sessionIdOf(data.accessToken)
  try {
    // Every page: a user with many sessions has this one past the first.
    const sessions = await (
      await users.listSessions(data.user.id)
    ).autoPagination()
    const live = sessions.find((s) => s.id === sid)
    return live?.status === "active" ? "valid" : "ended"
  } catch (error) {
    if (error.status === 404) return "ended"
    throw error
  }
}
