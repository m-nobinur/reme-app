import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A request whose session cookie AuthKit could not turn into a user. AuthKit
 * has already tried one refresh and the diagnostic tries another, so a cookie
 * left as it is costs two WorkOS calls on every request after it. The
 * middleware is called directly, with a `next` that answers like a page.
 */

const kit = {
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}

vi.mock("@workos/authkit-tanstack-react-start", () => ({
  authkitMiddleware: () => ({}),
  getAuthkit: async () => kit,
}))

const { noUserLog } = await import("./start")

type Result = { response: Response }
type Server = (args: {
  request: Request
  context: { auth: () => { user: null } }
  next: () => Promise<Result>
}) => Promise<Result>

const server = (noUserLog as unknown as { options: { server: Server } }).options
  .server

/** A token whose `exp` is a minute ago, unsigned: only `exp` is read. */
const expired = `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }))}.s`

const setCookie = (value: string) => ({
  response: new Response(null, { headers: { "set-cookie": value } }),
})

const answer = async () => {
  const { response } = await server({
    request: new Request("https://app.remeai.co.uk/app", {
      headers: { cookie: "wos-session=sealed" },
    }),
    context: { auth: () => ({ user: null }) },
    next: async () => ({
      response: new Response(null, {
        status: 307,
        headers: { location: "/sign-in" },
      }),
    }),
  })
  return response
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  kit.getSession.mockResolvedValue({ accessToken: expired, refreshToken: "r" })
  kit.clearSession.mockResolvedValue(setCookie("wos-session=; Max-Age=0"))
  kit.saveSession.mockResolvedValue(setCookie("wos-session=fresh"))
})

describe("a session cookie that found no user", () => {
  it("is cleared when WorkOS refuses its refresh token for good", async () => {
    kit.refreshSession.mockRejectedValue(
      Object.assign(new Error("Failed to refresh tokens"), {
        cause: { error: "invalid_grant" },
      })
    )
    const response = await answer()
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("/sign-in")
    expect(response.headers.getSetCookie()).toEqual(["wos-session=; Max-Age=0"])
  })

  it("is replaced when the diagnostic refresh works, since it spent the old token", async () => {
    kit.refreshSession.mockResolvedValue({ encryptedSession: "fresh" })
    const response = await answer()
    expect(kit.saveSession).toHaveBeenCalledWith(undefined, "fresh")
    expect(response.headers.getSetCookie()).toEqual(["wos-session=fresh"])
  })

  it("is left alone when the refresh failed for a passing reason", async () => {
    kit.refreshSession.mockRejectedValue(new TypeError("fetch failed"))
    const response = await answer()
    expect(kit.clearSession).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie()).toEqual([])
  })
})
