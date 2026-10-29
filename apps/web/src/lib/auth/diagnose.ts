import type { AuthService } from "@workos/authkit-tanstack-react-start"
import { sessionCookie } from "./workos"

/**
 * Why a request that carried a session cookie reached us with no user.
 *
 * AuthKit's `withAuth` (in @workos/authkit-session 0.7.1) catches every error
 * and answers "no user", with no hook or callback to say why, so a session
 * that died after an idle spell left nothing in the Worker's logs. This
 * repeats its steps on that path only: read the cookie, unseal it, and, for
 * an expired access token, refresh once to learn WorkOS's error code. The
 * line carries the failure class, the path and the cookie's length, never
 * the cookie, a token or a user id.
 */
type NoUserReason = {
  event: "auth.no_user"
  class: "cookie_absent" | "unseal_failed" | "refresh_failed" | "unknown"
  /** WorkOS's error code on a failed refresh. */
  code?: string
  path: string
  cookie_length: number
}

type Kit = Pick<AuthService<Request, Response>, "getSession" | "refreshSession">

/** The `exp` of a JWT, read without verifying it; null when unreadable. */
function expiresAt(token: string): number | null {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "")
    ) as { exp?: unknown }
    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/** The code WorkOS put on a refresh refusal, through AuthKit's wrapper. */
export function codeOf(error: unknown): string {
  const cause = (error as { cause?: Record<string, unknown> } | null)?.cause
  for (const field of ["error", "code", "name"] as const) {
    const value = cause?.[field]
    if (typeof value === "string") return value
  }
  return "none"
}

/** The length of the named cookie in the request, or 0 when it is absent. */
const cookieLength = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1).length ?? 0

/**
 * The reason, and the sealed session when the diagnostic refresh worked. That
 * refresh spent the cookie's refresh token, so the caller has to save it; it
 * sits beside the reason so the logged line can never carry it.
 */
export async function whyNoUser(
  request: Request,
  kit: Kit,
  now = Date.now()
): Promise<{ reason: NoUserReason; sealed?: string }> {
  const path = new URL(request.url).pathname
  const base = { event: "auth.no_user" as const, path }
  const cookie_length = cookieLength(request, sessionCookie())
  let session: Awaited<ReturnType<Kit["getSession"]>>
  try {
    session = await kit.getSession(request)
  } catch {
    return { reason: { ...base, class: "unseal_failed", cookie_length } }
  }
  if (!session) {
    return { reason: { ...base, class: "cookie_absent", cookie_length } }
  }
  const expiry = expiresAt(session.accessToken)
  if (expiry === null || expiry > now) {
    return { reason: { ...base, class: "unknown", cookie_length } }
  }
  try {
    const { encryptedSession } = await kit.refreshSession(session)
    // It refreshes now: the failure was passing, and what it was is gone.
    return {
      reason: { ...base, class: "unknown", cookie_length },
      sealed: encryptedSession,
    }
  } catch (error) {
    return {
      reason: {
        ...base,
        class: "refresh_failed",
        code: codeOf(error),
        cookie_length,
      },
    }
  }
}
