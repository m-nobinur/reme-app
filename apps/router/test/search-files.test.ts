import { describe, expect, it } from "vitest"
import app from "../src/index.ts"

/** The Search Console verification file, the IndexNow key and staging's noindex. */

const FILE = "google1a2b3c4d5e6f.html"
const KEY = "0123456789abcdef0123456789abcdef"
const kv = new Map<string, unknown>()
const base = {
  PREVIEW_KEY: "k",
  ROUTES: { get: async (key: string) => kv.get(key) ?? null },
  // Any read past the files under test would be a bug here.
  SITES: {
    get: async () => {
      throw new Error("R2 read")
    },
  },
  HYPERDRIVE: { connectionString: "postgres://stub" },
  MISSES: { limit: async () => ({ success: true }) },
}
const stg = {
  ...base,
  SITE_HOST_SUFFIX: "-stg.remeai.co.uk",
  INDEXNOW_KEY: KEY,
} as unknown as Env
const prod = {
  ...base,
  SITE_HOST_SUFFIX: ".remeai.co.uk",
  SERVICE_HOSTS: "api.remeai.co.uk",
  INDEXNOW_KEY: KEY,
} as unknown as Env

const HOST = "brightclean-stg.remeai.co.uk"
const get = (host: string, path: string, env = stg, method = "GET") =>
  app.request(`https://${host}${path}`, { method }, env)

describe("the verification file", () => {
  it("is served only while its key is in KV", async () => {
    expect((await get(HOST, `/${FILE}`)).status).toBe(404)
    kv.set(`gsv:${HOST}:${FILE}`, "1")
    const res = await get(HOST, `/${FILE}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toBe(`google-site-verification: ${FILE}`)
    expect((await get(HOST, "/google0000.html")).status).toBe(404)
    expect((await get("other-stg.remeai.co.uk", `/${FILE}`)).status).toBe(404)
  })

  it("answers HEAD with no body", async () => {
    const res = await get(HOST, `/${FILE}`, stg, "HEAD")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
  })

  it("wins over a redirect pointer", async () => {
    const host = "sparkle.co.uk"
    kv.set(`host:${host}`, { redirect_to: "www.sparkle.co.uk" })
    kv.set(`gsv:${host}:${FILE}`, "1")
    expect((await get(host, `/${FILE}`)).status).toBe(200)
    expect((await get(host, "/")).status).toBe(301)
  })

  it("skips a preview host", async () => {
    const host = "preview-v3-brightclean-stg.remeai.co.uk"
    kv.set(`gsv:${host}:${FILE}`, "1")
    expect((await get(host, `/${FILE}`)).status).toBe(401)
  })
})

describe("the IndexNow key", () => {
  // A wrong key falls through to the catch-all, which here is this redirect.
  kv.set(`host:${HOST}`, { redirect_to: "elsewhere.example" })
  it("is served as text at /{key}.txt, and only that key", async () => {
    const res = await get(HOST, `/${KEY}.txt`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/plain")
    expect(await res.text()).toBe(KEY)
    expect(
      (await get(HOST, "/fedcba9876543210fedcba9876543210.txt")).status
    ).toBe(301)
  })

  it("is not served when the Worker has no key", async () => {
    const none = { ...stg, INDEXNOW_KEY: undefined } as unknown as Env
    expect((await get(HOST, `/${KEY}.txt`, none)).status).toBe(301)
  })
})

describe("noindex", () => {
  it("marks every staging response, and no production one", async () => {
    kv.set(`gsv:${HOST}:${FILE}`, "1")
    for (const path of [`/${FILE}`, "/nothing"]) {
      expect((await get(HOST, path)).headers.get("x-robots-tag")).toBe(
        "noindex"
      )
    }
    const prodHost = "brightclean.remeai.co.uk"
    kv.set(`gsv:${prodHost}:${FILE}`, "1")
    for (const path of [`/${FILE}`, "/nothing"]) {
      const res = await get(prodHost, path, prod)
      expect(res.headers.get("x-robots-tag")).toBeNull()
    }
  })
})
