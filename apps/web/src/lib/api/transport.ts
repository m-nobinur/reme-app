import { getCookie } from "@tanstack/react-start/server"
import { sessionEncryption } from "@workos/authkit-session"
import { getAuthKitContextOrNull } from "@workos/authkit-tanstack-react-start"
import type { ErrorEnvelope } from "@workspace/contracts"

/**
 * How a request from `apps/web` reaches `apps/api`: with the session AuthKit
 * resolved, and with a bound on how long the api has to start answering.
 */

/** The cookie AuthKit writes and `apps/api` reads (ADR-024, ADR-026). */
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

export async function forwardedSession(): Promise<string | undefined> {
  const context = getAuthKitContextOrNull()
  if (!context) return getCookie(COOKIE)
  const auth = context.auth()
  if (!auth.user) return undefined
  let seal = sealed.get(context.request)
  if (!seal) {
    const password = process.env.WORKOS_COOKIE_PASSWORD
    if (!password) {
      throw new Error("WORKOS_COOKIE_PASSWORD is not set on this Worker.")
    }
    // The fields `AuthKitCore.encryptSession` seals, from the same session.
    seal = sessionEncryption.sealData(
      {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        user: auth.user,
        impersonator: auth.impersonator,
      },
      { password, ttl: 0 }
    )
    sealed.set(context.request, seal)
  }
  return await seal
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
export async function apiFetch(url: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (!controller.signal.aborted) throw error
    const envelope: ErrorEnvelope = {
      class: "transient",
      code: "api.timeout",
      message: "The service did not answer in time. Try again.",
      occurred_at: new Date().toISOString(),
      detail: { path: url.pathname, timeout_ms: API_TIMEOUT_MS },
    }
    return Response.json(envelope, { status: 504 })
  } finally {
    clearTimeout(timer)
  }
}
