import { WorkOS } from "@workos-inc/node"

/**
 * Who a request is, read from the sealed session cookie.
 *
 * This is §9.2 layer 1. Nothing else in this worker learns an identity, and no
 * handler takes one as an argument it could have read off a request body: the
 * two ids below arrive from the cookie or the request is refused. That is what
 * makes "org_id never comes from client input" a property of the code rather
 * than a habit, because even the vendor ids that resolve it are session-borne.
 *
 * `apps/web` writes the cookie (ADR-026) and this reads it. There is no shared
 * format between them and no cryptography here: `loadSealedSession(...)
 * .authenticate()` is the SDK's own API (ADR-024), it unseals with the shared
 * cookie password and verifies the access token's signature against WorkOS's
 * JWKS, and a tampered seal comes back as `authenticated: false` rather than as
 * an exception. Both workers hold `WORKOS_API_KEY` and
 * `WORKOS_COOKIE_PASSWORD`; the rule ADR-026 leaves is that neither reaches a
 * client bundle, and this file is only ever imported by the Worker entry.
 */

/** The kit's default, and `apps/web` does not override it. */
const COOKIE = "wos-session"

export type Session = {
  /** `session.user.id`, the WorkOS user. Never our `users.id`. */
  workosUserId: string
  /** From the access token. Absent until an org has been selected. */
  workosOrganizationId?: string
  /** The access token's `sid`, the WorkOS session this request belongs to. */
  sessionId: string
  /** A WorkOS admin is signed in as this person. */
  impersonated: boolean
  email: string
  name: string | null
} | null

function required(
  env: Env,
  name: "WORKOS_API_KEY" | "WORKOS_CLIENT_ID" | "WORKOS_COOKIE_PASSWORD"
) {
  const value = env[name]
  if (!value) {
    throw new Error(
      `${name} is not set on this Worker. Local values go in apps/api/.dev.vars; deployed values are wrangler secrets.`
    )
  }
  return value
}

let client: WorkOS | undefined

export function workos(env: Env): WorkOS {
  client ??= new WorkOS(required(env, "WORKOS_API_KEY"), {
    clientId: required(env, "WORKOS_CLIENT_ID"),
  })
  return client
}

/** The sealed value out of the `Cookie` header, or null. */
function sealed(request: Request): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=")
    if (at === -1) continue
    if (pair.slice(0, at).trim() === COOKIE) {
      return decodeURIComponent(pair.slice(at + 1).trim()) || null
    }
  }
  return null
}

/**
 * Returns the session, or null for anything that is not one: no cookie, a
 * cookie that does not unseal, an expired or forged token.
 *
 * No refresh. A session this worker cannot authenticate is a 401 and the web
 * app's own middleware is what refreshes and redirects; refreshing here would
 * mean writing a cookie from the worker that does not own the session.
 */
export async function readSession(
  request: Request,
  env: Env
): Promise<Session> {
  const data = sealed(request)
  if (!data) return null
  const session = workos(env).userManagement.loadSealedSession({
    sessionData: data,
    cookiePassword: required(env, "WORKOS_COOKIE_PASSWORD"),
  })
  let result: Awaited<ReturnType<typeof session.authenticate>>
  try {
    result = await session.authenticate()
  } catch (error) {
    // A seal cut mid-component fails base64 decoding before anything is
    // fetched, and the SDK rethrows that one: a bad cookie, so signed out.
    // Anything else, an unreachable JWKS among them, stays a throw and a 503:
    // signing everyone out during a WorkOS outage is worse.
    if (error instanceof DOMException && error.name === "InvalidCharacterError")
      return null
    throw error
  }
  if (!result.authenticated) return null
  const { user, organizationId, sessionId, impersonator } = result
  return {
    workosUserId: user.id,
    workosOrganizationId: organizationId,
    sessionId,
    impersonated: Boolean(impersonator),
    email: user.email,
    name:
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null,
  }
}
