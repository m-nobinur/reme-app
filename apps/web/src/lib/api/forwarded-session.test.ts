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
// A new one per test: the seal is cached per request.
let request = new Request("https://web.test/api/chat")
/** AuthKit's own refresh, as `forwardedSession` calls it. */
const kit = {
  refreshSession: vi.fn(),
  saveSession: vi.fn(async () => ({})),
}

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => (name === "wos-session" ? STALE : undefined),
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthKitContextOrNull: () => ({ request, auth: () => auth }),
  getAuthkit: async () => kit,
}))

const cookies: string[] = []

beforeEach(() => {
  process.env.REME_API_URL = "https://api.test"
  process.env.WORKOS_COOKIE_PASSWORD = PASSWORD
  cookies.length = 0
  request = new Request("https://web.test/api/chat")
  kit.refreshSession.mockReset()
  kit.saveSession.mockClear()
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

const now = () => Math.floor(Date.now() / 1000)

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
    claims: { exp: now() + 120 },
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

/**
 * A token the web accepts in its last moments can expire before the api
 * checks it, and the api, which never refreshes, answers 401. Both verify
 * with no clock tolerance, so the web refreshes one about to expire first.
 */
it("refreshes a token about to expire before forwarding it", async () => {
  const FRESH = crypto.randomUUID()
  const fresh = await sessionEncryption.sealData(
    { accessToken: FRESH, refreshToken: REFRESH, user: USER },
    { password: PASSWORD, ttl: 0 }
  )
  kit.refreshSession.mockResolvedValue({ auth: {}, encryptedSession: fresh })
  auth = {
    user: USER,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    organizationId: "org_01",
    claims: { exp: now() + 2 },
  }
  const { apiSource } = await import("./client")
  await apiSource.chat("{}")

  expect(kit.refreshSession).toHaveBeenCalledWith(
    { accessToken: ACCESS, refreshToken: REFRESH, user: USER },
    "org_01"
  )
  // The browser gets the new cookie, so its next request carries it.
  expect(kit.saveSession).toHaveBeenCalledWith(undefined, fresh)
  expect((await forwarded(cookies[0] ?? "")).accessToken).toBe(FRESH)
})

it("forwards the token it has when that refresh fails", async () => {
  kit.refreshSession.mockRejectedValue(new Error("Failed to refresh tokens"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  auth = {
    user: USER,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    claims: { exp: now() + 2 },
  }
  const { apiSource } = await import("./client")
  await apiSource.chat("{}")

  // Still valid for now. A session that has truly ended fails the next
  // request's own refresh in the middleware, as before.
  expect(kit.saveSession).not.toHaveBeenCalled()
  expect((await forwarded(cookies[0] ?? "")).accessToken).toBe(ACCESS)
  expect(warn.mock.calls.join(" ")).not.toContain(REFRESH)
  warn.mockRestore()
})
