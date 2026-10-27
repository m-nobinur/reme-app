import { beforeEach, describe, expect, it, vi } from "vitest"

// An in-memory cookie jar standing in for the request/response cookies.
const jar = new Map<
  string,
  { value: string; options: Record<string, unknown> }
>()
const getAuth = vi.fn()
const googleConnect = vi.fn()
const googleResult = vi.fn()

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}))
vi.mock("@tanstack/react-start/server", () => ({
  setCookie: (name: string, value: string, options: Record<string, unknown>) =>
    jar.set(name, { value, options }),
  getCookie: (name: string) => jar.get(name)?.value,
  deleteCookie: (name: string) => jar.delete(name),
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({ getAuth }))
vi.mock("@/lib/api/source", () => ({ source: { googleConnect, googleResult } }))
vi.mock("@/lib/auth/workos", () => ({ redirectUri: () => "unused" }))

const ORIGIN = "https://staging.remeai.co.uk"
const signedIn = {
  user: { id: "user_1", email: "a@b.co" },
  organizationId: "org_1",
  sessionId: "s",
}

type Route = {
  options: {
    server: {
      handlers: { GET: (c: { request: Request }) => Promise<Response> }
    }
  }
}
async function run(file: "start" | "callback", query = "", referer?: string) {
  const { Route } = (await (file === "start"
    ? import("../routes/api.google.start")
    : import("../routes/api.google.callback"))) as unknown as { Route: Route }
  return await Route.options.server.handlers.GET({
    request: new Request(`${ORIGIN}/api/google/${file}${query}`, {
      headers: referer ? { referer } : {},
    }),
  })
}

/** Starts a flow and returns the state Google would echo back. */
async function start(referer?: string) {
  const response = await run("start", "", referer)
  return new URL(response.headers.get("location") as string)
}

beforeEach(() => {
  jar.clear()
  getAuth.mockReset().mockResolvedValue(signedIn)
  googleConnect.mockReset().mockResolvedValue("connected")
  googleResult.mockReset().mockResolvedValue(undefined)
  process.env.GOOGLE_CLIENT_ID = "client-123"
})

describe("/api/google/start", () => {
  it("sends the owner to Google with PKCE and a path-scoped state cookie", async () => {
    const auth = await start()
    expect(auth.origin + auth.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    )
    const p = auth.searchParams
    expect(p.get("client_id")).toBe("client-123")
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/api/google/callback`)
    expect(p.get("access_type")).toBe("offline")
    expect(p.get("prompt")).toBe("consent")
    expect(p.get("include_granted_scopes")).toBe("true")
    expect(p.get("code_challenge_method")).toBe("S256")
    expect(p.get("scope")).toContain("auth/webmasters")
    expect(p.get("scope")).toContain("siteverification.verify_only")

    const cookie = jar.get("reme-google-state")
    expect(cookie?.options).toMatchObject({
      path: "/api/google",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 3600,
    })
    const stored = JSON.parse(cookie?.value as string)
    expect(stored.state).toBe(p.get("state"))
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stored.verifier)
    )
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    expect(p.get("code_challenge")).toBe(challenge)
  })

  it("is off without a client id", async () => {
    process.env.GOOGLE_CLIENT_ID = ""
    const response = await run("start")
    expect(response.headers.get("location")).toBe(`${ORIGIN}/app`)
    expect(jar.size).toBe(0)
  })

  it("needs a session with an organisation", async () => {
    getAuth.mockResolvedValue({ user: null })
    const response = await run("start")
    expect(response.headers.get("location")).toBe(`${ORIGIN}/sign-in`)
    expect(jar.size).toBe(0)
  })
})

describe("/api/google/callback", () => {
  const where = (response: Response) => response.headers.get("location")

  it("posts the code, verifier and redirect uri, then reports connected", async () => {
    const state = (await start()).searchParams.get("state")
    const verifier = JSON.parse(
      jar.get("reme-google-state")?.value as string
    ).verifier
    const response = await run("callback", `?code=abc&state=${state}`)
    expect(googleConnect).toHaveBeenCalledWith({
      code: "abc",
      verifier,
      redirect_uri: `${ORIGIN}/api/google/callback`,
    })
    expect(where(response)).toBe(`${ORIGIN}/app`)
    expect(jar.has("reme-google-state")).toBe(false)
    expect(googleResult).toHaveBeenCalledExactlyOnceWith(state, "connected")
  })

  it("passes on a missing scope", async () => {
    googleConnect.mockResolvedValue("scopes_missing")
    const state = (await start()).searchParams.get("state")
    const response = await run("callback", `?code=abc&state=${state}`)
    expect(where(response)).toBe(`${ORIGIN}/app`)
    expect(googleResult).toHaveBeenCalledExactlyOnceWith(
      state,
      "scopes_missing"
    )
  })

  it("fails on a state that does not match, and spends the cookie", async () => {
    await start()
    const response = await run("callback", "?code=abc&state=forged")
    expect(where(response)).toBe(`${ORIGIN}/app`)
    expect(googleConnect).not.toHaveBeenCalled()
    expect(jar.has("reme-google-state")).toBe(false)
    // Unverified: keyed by the hour, never by what the link said.
    expect(googleResult).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^unverified-\d{4}-\d{2}-\d{2}T\d{2}$/),
      "failed"
    )
  })

  it("fails with no state cookie", async () => {
    const response = await run("callback", "?code=abc&state=anything")
    expect(where(response)).toBe(`${ORIGIN}/app`)
    expect(googleConnect).not.toHaveBeenCalled()
  })

  it("says a cancelled consent quietly, and only for a flow this browser started", async () => {
    const state = (await start()).searchParams.get("state")
    const response = await run(
      "callback",
      `?error=access_denied&state=${state}`
    )
    expect(where(response)).toBe(`${ORIGIN}/app`)
    expect(googleConnect).not.toHaveBeenCalled()
    expect(googleResult).toHaveBeenCalledExactlyOnceWith(state, "cancelled")
    expect(jar.has("reme-google-state")).toBe(false)

    googleResult.mockClear()
    await start()
    await run("callback", "?error=access_denied&state=forged")
    expect(googleResult).not.toHaveBeenCalled()
  })

  it("returns to the chat the owner came from, from the cookie and not the address", async () => {
    const state = (await start(`${ORIGIN}/app/chat-7`)).searchParams.get(
      "state"
    )
    const response = await run("callback", `?code=abc&state=${state}`)
    expect(where(response)).toBe(`${ORIGIN}/app/chat-7`)
  })
})
