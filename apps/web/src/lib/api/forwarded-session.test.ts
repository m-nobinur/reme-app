import { sessionEncryption } from "@workos/authkit-session"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * An owner idle past the access token's life (about five minutes) comes back
 * with a cookie holding the expired token. AuthKit's middleware refreshes it
 * for the request and sets the new cookie on the response, but the request
 * still carries the old one. Every call to `apps/api` must forward the
 * session AuthKit refreshed, not that cookie, or the api answers 401.
 */

// Made per run, so nothing that looks like a credential sits in the file.
const PASSWORD = crypto.randomUUID() + crypto.randomUUID()
const ACCESS = crypto.randomUUID()
const REFRESH = crypto.randomUUID()
const STALE = "sealed-with-the-expired-access-token"
const USER = { id: "user_01", email: "owner@example.net" }

let auth: Record<string, unknown> = {}
const request = new Request("https://web.test/api/chat")

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => (name === "wos-session" ? STALE : undefined),
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthKitContextOrNull: () => ({ request, auth: () => auth }),
}))

const cookies: string[] = []

beforeEach(() => {
  process.env.REME_API_URL = "https://api.test"
  process.env.WORKOS_COOKIE_PASSWORD = PASSWORD
  cookies.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init: RequestInit) => {
      cookies.push(String((init.headers as Record<string, unknown>).cookie))
      return new Response("data: [DONE]\n\n")
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const forwarded = async (cookie: string) =>
  await sessionEncryption.unsealData<Record<string, unknown>>(
    decodeURIComponent(cookie.replace(/^wos-session=/, "")),
    { password: PASSWORD }
  )

it("forwards the session AuthKit refreshed, not the expired cookie", async () => {
  auth = {
    user: USER,
    accessToken: ACCESS,
    refreshToken: REFRESH,
  }
  const { apiSource } = await import("./client")
  await apiSource.chat("{}")
  await apiSource.chat("{}")

  expect(cookies).toHaveLength(2)
  expect(cookies[0]).not.toContain(STALE)
  expect(await forwarded(cookies[0] ?? "")).toEqual({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    user: USER,
  })
  // Sealed once for the request.
  expect(cookies[1]).toBe(cookies[0])
})

it("forwards nothing when AuthKit found no session", async () => {
  auth = { user: null }
  const { apiSource } = await import("./client")
  expect(await apiSource.chat("{}")).toBeNull()
  expect(cookies).toEqual([])
})
