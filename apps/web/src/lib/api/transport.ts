import { getCookie } from "@tanstack/react-start/server"
import { sessionEncryption } from "@workos/authkit-session"
import {
  type AuthKitContext,
  getAuthKitContextOrNull,
  getAuthkit,
} from "@workos/authkit-tanstack-react-start"
import type { ErrorEnvelope } from "@workspace/contracts"
import { sessionCookie } from "@/lib/auth/workos"

/**
 * How a request from `apps/web` reaches `apps/api`: with the session AuthKit
 * resolved, and with a bound on how long the api has to start answering.
 */

/**
 * The cookie `apps/api` reads the forwarded session from (ADR-024, ADR-026).
 * The browser's own cookie is `sessionCookie()`, which only this Worker sees.
 */
export const COOKIE = "wos-session"

/**
 * The session to forward: the one AuthKit resolved for this request, sealed
 * again, and not the cookie the request arrived with. When the access token
 * has expired (after about five idle minutes), the middleware refreshes it
 * and sets the new cookie on the response, but the request still carries the
 * old one, which `apps/api` refuses with 401 `session.absent`. Sealed once per
 * request. With no AuthKit context (a unit test), the cookie as it came.
 */
const sealed = new WeakMap<Request, Promise<string>>()

/**
 * Seconds a forwarded access token must have left, AuthKit's own "expiring"
 * buffer. The middleware refreshes only a token already expired, and both
 * workers verify with no clock tolerance, so one accepted here in its last
 * moments could expire before `apps/api` checks it: a 401 mid-session.
 */
const TOKEN_LEFT_S = 10

export async function forwardedSession(): Promise<string | undefined> {
  const context = getAuthKitContextOrNull()
  if (!context) return getCookie(sessionCookie())
  const auth = context.auth()
  if (!auth.user) return undefined
  let seal = sealed.get(context.request)
  if (!seal) {
    seal = sealFor(auth)
    sealed.set(context.request, seal)
  }
  return await seal
}

async function sealFor(
  auth: Extract<ReturnType<AuthKitContext["auth"]>, { user: object }>
): Promise<string> {
  const password = process.env.WORKOS_COOKIE_PASSWORD
  if (!password) {
    throw new Error("WORKOS_COOKIE_PASSWORD is not set on this Worker.")
  }
  // The fields `AuthKitCore.encryptSession` seals, from the same session.
  const session = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: auth.user,
    impersonator: auth.impersonator,
  }
  const exp = auth.claims.exp ?? Number.POSITIVE_INFINITY
  if (exp - Date.now() / 1000 < TOKEN_LEFT_S) {
    try {
      // Concurrent refreshes of one token share one WorkOS call in this
      // isolate, and WorkOS answers a replay within 30 s with the same tokens.
      const authkit = await getAuthkit()
      const { encryptedSession } = await authkit.refreshSession(
        session,
        auth.organizationId
      )
      // Through the middleware's pending headers, onto this response.
      await authkit.saveSession(undefined, encryptedSession)
      return encryptedSession
    } catch (error) {
      // The token is still valid: forward it rather than end the session.
      console.warn(
        JSON.stringify({
          at: "session.refresh_early",
          message: error instanceof Error ? error.message : "unknown",
        })
      )
    }
  }
  return await sessionEncryption.sealData(session, { password, ttl: 0 })
}

/**
 * How long `apps/api` has to start answering. Its reads measure p95 125 to
 * 200 ms and a chat turn's first token is budgeted at 3 s (§30.2), so this is
 * well clear of a slow answer and well short of a hung page.
 */
export const API_TIMEOUT_MS = 10_000

/**
 * `fetch` to `apps/api`, bounded until the response starts. A request not
 * answered in `API_TIMEOUT_MS` is aborted and answered here with a 504
 * `transient` envelope (§28.1), the shape `apps/api` refuses with, so every
 * caller's handling of a 5xx applies unchanged. The body is not bounded: a
 * chat reply streams for as long as it takes.
 */
export async function apiFetch(
  url: URL,
  init: RequestInit,
  timeoutMs = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (!controller.signal.aborted) throw error
    const envelope: ErrorEnvelope = {
      class: "transient",
      code: "api.timeout",
      message: "The service did not answer in time. Try again.",
      occurred_at: new Date().toISOString(),
      detail: { path: url.pathname, timeout_ms: timeoutMs },
    }
    return Response.json(envelope, { status: 504 })
  } finally {
    clearTimeout(timer)
  }
}
