import {
  deleteCookie,
  getCookie,
  setCookie,
} from "@tanstack/react-start/server"
import { redirectUri } from "./workos"

/**
 * Social sign-in.
 *
 * The AuthKit kit cannot do this half. `generateAuthorizationUrl` in
 * `@workos/authkit-session` 0.7.1 hard-codes `provider: 'authkit'` and does not
 * forward a caller-supplied provider, so every URL it builds lands on the
 * WorkOS-hosted page — which is the thing DR-4a decided against. The backend
 * SDK's `getAuthorizationUrl` does take `provider`, so the redirect is ours.
 *
 * Owning the redirect means owning its CSRF protection. PKCE is not what does
 * that here: PKCE exists for clients that cannot hold a secret, and this one
 * holds the API key, so the code exchange is already authenticated. What is
 * needed is proof that the callback belongs to a flow this browser started,
 * which is a random `state` echoed back and compared against a cookie only this
 * origin can read.
 */

/**
 * Google is the one social provider, by the owner's choice on 2026-09-30. A
 * provider that is not on this list never reaches WorkOS, whatever the WorkOS
 * environment has enabled.
 */
const PROVIDERS = new Set(["GoogleOAuth"])

const STATE_COOKIE = "reme-oauth-state"

/**
 * A redirect whose headers can still be written to.
 *
 * `Response.redirect()` returns a response with **immutable** headers under
 * workerd. TanStack Start merges the `Set-Cookie` values from `setCookie()`
 * onto whatever a route handler returns, so a redirect built that way throws
 * `TypeError: Can't modify immutable headers` and the route 500s. Measured: the
 * social redirect failed exactly on the branch that sets the state cookie, and
 * the branch that sets no cookie was fine, which is what pointed at the merge.
 */
export function seeOther(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

export function isSupportedProvider(value: unknown): value is string {
  return typeof value === "string" && PROVIDERS.has(value)
}

export function beginOAuth(returnTo: string): {
  state: string
  redirectUri: string
} {
  const state = crypto.randomUUID()
  setCookie(STATE_COOKIE, JSON.stringify({ state, returnTo }), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // Lax rather than strict: the browser arrives back here from the provider
    // as a cross-site top-level navigation, and strict would withhold the
    // cookie on exactly that request.
    secure: redirectUri().startsWith("https:"),
    maxAge: 10 * 60,
  })
  return { state, redirectUri: redirectUri() }
}

/**
 * Reads and spends the flow this callback claims to belong to. Returns null
 * when there is nothing to match against or the value does not match, which is
 * the same answer for a missing cookie, an expired one and a forged `state`.
 */
export function consumeOAuthState(state: unknown): { returnTo: string } | null {
  const raw = getCookie(STATE_COOKIE)
  deleteCookie(STATE_COOKIE, { path: "/" })
  if (!raw || typeof state !== "string" || state.length === 0) {
    return null
  }
  try {
    const stored = JSON.parse(raw) as { state?: string; returnTo?: string }
    if (stored.state !== state) {
      return null
    }
    return { returnTo: stored.returnTo ?? "/app" }
  } catch {
    return null
  }
}
