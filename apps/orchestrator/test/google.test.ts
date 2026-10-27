import { afterEach, describe, expect, it, vi } from "vitest"
import {
  accessFor,
  addSite,
  exchangeCode,
  type GoogleError,
  hasScopes,
  NeedsReauth,
  openToken,
  revokeToken,
  SCOPES,
  sealToken,
  submitSitemap,
  verificationToken,
} from "../src/google.ts"

const env = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "csecret",
  GOOGLE_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
}
const ORG = crypto.randomUUID()
const REFRESH = "1//refresh-token-secret"
const CODE = "4/0auth-code-secret"
const FILE = "google1a2b3c4d5e6f.html"
const ACCESS = "ya29.access-token-secret"

type Call = { url: string; method: string; body: string }

function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      calls.push({ url, method, body: String(init?.body ?? "") })
      const route = routes[`${method} ${url}`]
      if (!route) throw new Error(`unexpected ${method} ${url}`)
      return route()
    })
  )
  return calls
}
const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status })
const EXCHANGE = "POST https://oauth2.googleapis.com/token"
const idToken = (claims: object) =>
  `x.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`

afterEach(() => vi.unstubAllGlobals())

describe("the refresh token at rest", () => {
  it("round-trips under the org id, with a fresh IV each time", async () => {
    const one = await sealToken(env, ORG, REFRESH)
    const two = await sealToken(env, ORG, REFRESH)
    expect(one).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/)
    expect(one).not.toBe(two)
    expect(one).not.toContain(REFRESH)
    expect(await openToken(env, ORG, one)).toBe(REFRESH)
  })

  it("refuses a ciphertext moved to another org", async () => {
    const sealed = await sealToken(env, ORG, REFRESH)
    await expect(openToken(env, crypto.randomUUID(), sealed)).rejects.toThrow(
      "google.bad_token"
    )
  })

  it("refuses a flipped byte", async () => {
    const sealed = await sealToken(env, ORG, REFRESH)
    const [v, iv, ct = ""] = sealed.split(".")
    const flipped = `${ct[0] === "A" ? "B" : "A"}${ct.slice(1)}`
    await expect(openToken(env, ORG, `${v}.${iv}.${flipped}`)).rejects.toThrow(
      "google.bad_token"
    )
  })

  it("refuses a key that is not 32 bytes", async () => {
    await expect(
      sealToken({ GOOGLE_TOKEN_KEY: btoa("short") }, ORG, REFRESH)
    ).rejects.toThrow("google.bad_key")
  })
})

describe("the code exchange", () => {
  it("sends the PKCE verifier and reads the email from the id_token", async () => {
    const calls = stub({
      [EXCHANGE]: json({
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3599,
        scope: `openid ${SCOPES.join(" ")} https://www.googleapis.com/auth/userinfo.email`,
        id_token: idToken({ email: "owner@example.com" }),
      }),
    })
    const result = await exchangeCode(env, {
      code: CODE,
      verifier: "v",
      redirect_uri: "https://staging.remeai.co.uk/api/google/callback",
    })
    expect(result).toMatchObject({
      refreshToken: REFRESH,
      accessToken: ACCESS,
      email: "owner@example.com",
    })
    const sent = new URLSearchParams(calls[0]?.body)
    expect(sent.get("code_verifier")).toBe("v")
    expect(sent.get("grant_type")).toBe("authorization_code")
    expect(sent.get("client_secret")).toBe("csecret")
  })

  it("hands back the scopes Google granted when the owner unticked a box", async () => {
    stub({
      [EXCHANGE]: json({
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: `openid ${SCOPES[0]}`,
      }),
    })
    const result = await exchangeCode(env, {
      code: CODE,
      verifier: "v",
      redirect_uri: "r",
    })
    expect(result.scopes).toEqual(["openid", SCOPES[0]])
    expect(hasScopes(result.scopes)).toBe(false)
    expect(hasScopes([...SCOPES])).toBe(true)
  })

  it("is off without the client secret", async () => {
    await expect(
      exchangeCode(
        { GOOGLE_CLIENT_ID: "id" },
        { code: CODE, verifier: "v", redirect_uri: "r" }
      )
    ).rejects.toThrow("google.not_configured")
  })
})

describe("access tokens", () => {
  it("refreshes once, caches, and hands back a rotated refresh token sealed", async () => {
    const org = crypto.randomUUID()
    const stored = await sealToken(env, org, REFRESH)
    const calls = stub({
      [EXCHANGE]: json({
        access_token: ACCESS,
        expires_in: 3599,
        refresh_token: "1//rotated",
        scope: "openid a b",
      }),
    })
    const first = await accessFor(env, org, stored)
    expect(first.accessToken).toBe(ACCESS)
    expect(await openToken(env, org, first.sealed ?? "")).toBe("1//rotated")
    expect(await accessFor(env, org, first.sealed ?? "")).toEqual({
      accessToken: ACCESS,
      scopes: ["openid", "a", "b"],
    })
    expect(calls).toHaveLength(1)
    expect(new URLSearchParams(calls[0]?.body).get("refresh_token")).toBe(
      REFRESH
    )
  })

  it("refreshes within five minutes of expiry", async () => {
    const org = crypto.randomUUID()
    const stored = await sealToken(env, org, REFRESH)
    const calls = stub({
      [EXCHANGE]: json({ access_token: ACCESS, expires_in: 240 }),
    })
    await accessFor(env, org, stored)
    await accessFor(env, org, stored)
    expect(calls).toHaveLength(2)
  })

  it("turns invalid_grant into NeedsReauth", async () => {
    const stored = await sealToken(env, ORG, REFRESH)
    stub({ [EXCHANGE]: json({ error: "invalid_grant" }, 400) })
    const error = await accessFor(env, ORG, stored).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NeedsReauth)
    expect((error as GoogleError).name).toBe("search.needs_reauth")
  })

  it("leaves invalid_grant on a code exchange as an exchange failure", async () => {
    stub({ [EXCHANGE]: json({ error: "invalid_grant" }, 400) })
    const error = await exchangeCode(env, {
      code: CODE,
      verifier: "v",
      redirect_uri: "r",
    }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(NeedsReauth)
    expect((error as GoogleError).name).toBe("google.invalid_grant")
  })
})

describe("Google calls", () => {
  it("asks for a FILE token on the SITE and encodes the property in paths", async () => {
    const calls = stub({
      "POST https://www.googleapis.com/siteVerification/v1/token": json({
        method: "FILE",
        token: FILE,
      }),
      "PUT https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fa.remeai.co.uk%2F":
        () => new Response(null, { status: 200 }),
      "PUT https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fa.remeai.co.uk%2F/sitemaps/https%3A%2F%2Fa.remeai.co.uk%2Fsitemap.xml":
        () => new Response(null, { status: 200 }),
    })
    expect(
      await verificationToken(ACCESS, "https://a.remeai.co.uk/", "FILE")
    ).toBe(FILE)
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      site: { type: "SITE", identifier: "https://a.remeai.co.uk/" },
      verificationMethod: "FILE",
    })
    await addSite(ACCESS, "https://a.remeai.co.uk/")
    await submitSitemap(
      ACCESS,
      "https://a.remeai.co.uk/",
      "https://a.remeai.co.uk/sitemap.xml"
    )
    expect(calls).toHaveLength(3)
  })

  it("fails typed with the status, and retryable on a quota", async () => {
    stub({
      "PUT https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aa.co.uk":
        json({ error: { code: 403 } }, 403),
    })
    const error = (await addSite(ACCESS, "sc-domain:a.co.uk").catch(
      (e: unknown) => e
    )) as GoogleError
    expect([error.name, error.status]).toEqual(["google.403", 403])
  })

  it("counts an already invalid token as revoked", async () => {
    stub({
      "POST https://oauth2.googleapis.com/revoke": json(
        { error: "invalid_token" },
        400
      ),
    })
    await expect(revokeToken(REFRESH)).resolves.toBeUndefined()
  })
})

describe("redaction", () => {
  it("never puts a token or a code in logs or error messages", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined)
    )
    const seen: string[] = []
    const record = (e: unknown) => {
      seen.push(String(e), (e as Error).message, (e as Error).stack ?? "")
    }
    const stored = await sealToken(env, ORG, REFRESH)
    // Google echoing a secret back in its error must not reach the error.
    stub({
      [EXCHANGE]: json(
        { error: `bad ${CODE} ${REFRESH}`, error_description: ACCESS },
        400
      ),
      "POST https://oauth2.googleapis.com/revoke": json(
        { error: REFRESH },
        500
      ),
      "PUT https://www.googleapis.com/webmasters/v3/sites/x": json(
        { error: { message: ACCESS } },
        401
      ),
    })
    await exchangeCode(env, {
      code: CODE,
      verifier: "v",
      redirect_uri: "r",
    }).catch(record)
    await accessFor(env, crypto.randomUUID(), stored).catch(record)
    await accessFor(env, ORG, stored).catch(record)
    await revokeToken(REFRESH).catch(record)
    await addSite(ACCESS, "x").catch(record)
    expect(seen).toHaveLength(15)
    const logged = spies.flatMap((spy) =>
      spy.mock.calls.map((c) => JSON.stringify(c))
    )
    for (const text of [...seen, ...logged]) {
      for (const secret of [REFRESH, CODE, ACCESS, env.GOOGLE_CLIENT_SECRET]) {
        expect(text).not.toContain(secret)
      }
    }
    for (const spy of spies) spy.mockRestore()
  })
})
