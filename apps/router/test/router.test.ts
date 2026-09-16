import { signPreview } from "@workspace/gates/preview"
import { describe, expect, it } from "vitest"
import app from "../src/index.ts"

/**
 * The router without a binding in sight: R2 and KV are maps, the claim is
 * signed with the suite's key, and every answer is read off the response.
 */

const KEY = "preview-key-for-this-suite-only"
const SUFFIX = "-stg.remeai.co.uk"
const ORG = "10000001-0000-4000-8000-000000000001"
const OTHER = "10000001-0000-4000-8000-000000000002"
const REV = "10000001-0000-4000-8000-000000000003"
const OTHER_REV = "10000001-0000-4000-8000-000000000004"
const PREVIEW_HOST = `preview-v3-brightclean${SUFFIX}`
const SITE_HOST = `brightclean${SUFFIX}`
const HEADERS = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
}

const objects = new Map<string, string>()
const pointers = new Map<string, unknown>()

function revision(
  orgId: string,
  id: string,
  extra: Record<string, unknown> = {}
) {
  const prefix = `sites/${orgId}/${id}/`
  objects.set(
    `${prefix}manifest.json`,
    JSON.stringify({
      revision_id: id,
      site_id: orgId,
      org_id: orgId,
      routes: [{ path: "/", file: "index.html" }],
      headers: HEADERS,
      files: {
        "index.html": "a".repeat(64),
        "contact/index.html": "b".repeat(64),
        "_astro/index.C1.css": "c".repeat(64),
      },
      built_at: "2026-09-16T00:00:00.000Z",
      ...extra,
    })
  )
  objects.set(`${prefix}dist/index.html`, `<h1>${id.slice(-4)}</h1>`)
  objects.set(`${prefix}dist/contact/index.html`, "<p>+15550142</p>")
  objects.set(`${prefix}dist/_astro/index.C1.css`, "body{}")
  objects.set(`${prefix}screenshots/home-390.png`, "png")
  objects.set(`${prefix}source.tar.zst`, "source")
}
revision(ORG, REV)
revision(OTHER, OTHER_REV)

const env = {
  SITE_HOST_SUFFIX: SUFFIX,
  PREVIEW_KEY: KEY,
  SITES: {
    get: async (key: string) => {
      const body = objects.get(key)
      return body === undefined
        ? null
        : { body, text: async () => body, json: async () => JSON.parse(body) }
    },
  },
  ROUTES: {
    get: async (key: string) => pointers.get(key) ?? null,
  },
} as unknown as Env

const soon = () => Math.floor(Date.now() / 1000) + 3600
const claimFor = (overrides: Record<string, unknown> = {}) =>
  signPreview(
    {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      host: PREVIEW_HOST,
      exp: soon(),
      ...overrides,
    } as never,
    KEY
  )
const cookie = (token: string) => ({ cookie: `reme_preview=${token}` })
const get = (host: string, path: string, init: RequestInit = {}) =>
  app.request(`https://${host}${path}`, init, env)

describe("hosts", () => {
  it("answers 404 for a host outside the suffix before reading anything", async () => {
    pointers.set("host:staging.remeai.co.uk", {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 1,
    })
    const res = await get("staging.remeai.co.uk", "/")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store")
    pointers.delete("host:staging.remeai.co.uk")
  })

  it("answers /api/* with the typed 501 on any host", async () => {
    for (const host of [SITE_HOST, PREVIEW_HOST]) {
      const res = await get(host, "/api/leads", { method: "POST" })
      expect(res.status).toBe(501)
      expect(await res.json()).toMatchObject({
        class: "resource",
        code: "route.not_implemented",
        detail: {},
      })
    }
  })
})

describe("a preview host", () => {
  it("answers 401 with no cookie, and the same 401 for an expired, forged or wrong-host one", async () => {
    const bare = await get(PREVIEW_HOST, "/")
    expect(bare.status).toBe(401)
    expect(bare.headers.get("www-authenticate")).toBeNull()
    expect(bare.headers.get("cache-control")).toBe("no-store")
    const body = await bare.text()
    const expired = await claimFor({ exp: Math.floor(Date.now() / 1000) - 1 })
    const elsewhere = await claimFor({ host: `preview-v2-other${SUFFIX}` })
    const forged = `${(await claimFor()).split(".")[0]}.AAAA`
    for (const token of [expired, elsewhere, forged, "junk"]) {
      const res = await get(PREVIEW_HOST, "/", { headers: cookie(token) })
      expect(res.status).toBe(401)
      expect(await res.text()).toBe(body)
    }
  })

  it("opens a signed link as a cookie for this host and redirects to the root", async () => {
    const token = await claimFor()
    const res = await get(PREVIEW_HOST, `/open?t=${token}`)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
    const set = res.headers.get("set-cookie") ?? ""
    expect(set).toContain(`reme_preview=${token}`)
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(set).toContain(attr)
    }
    expect(set).toMatch(/Max-Age=3[56]\d\d/)
  })

  it("refuses a bad link with 401 and sets no cookie", async () => {
    const bad = await get(PREVIEW_HOST, "/open?t=forged.token")
    expect(bad.status).toBe(401)
    expect(bad.headers.get("set-cookie")).toBeNull()
    expect(bad.headers.get("location")).toBeNull()
    const other = await get(
      PREVIEW_HOST,
      `/open?t=${await claimFor({ host: `preview-v2-other${SUFFIX}` })}`
    )
    expect(other.status).toBe(401)
    expect(other.headers.get("set-cookie")).toBeNull()
    // `/open` is a preview route; a published host has no such path.
    expect((await get(SITE_HOST, `/open?t=${await claimFor()}`)).status).toBe(
      404
    )
  })

  it("serves the revision's files with the manifest's headers, never stored", async () => {
    const c = cookie(await claimFor())
    const home = await get(PREVIEW_HOST, "/", { headers: c })
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("0003")
    expect(Object.fromEntries(home.headers)).toMatchObject({
      ...HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    })
    const css = await get(PREVIEW_HOST, "/_astro/index.C1.css", { headers: c })
    expect(css.headers.get("cache-control")).toBe("private, no-store")
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
    const contact = await get(PREVIEW_HOST, "/contact/", { headers: c })
    expect(await contact.text()).toContain("+15550142")
    const shot = await get(PREVIEW_HOST, "/screenshots/home-390.png", {
      headers: c,
    })
    expect(shot.status).toBe(200)
    expect(shot.headers.get("content-type")).toBe("image/png")
    for (const path of [
      "/source.tar.zst",
      "/manifest.json",
      "/dist/index.html",
      "/nope",
    ]) {
      const res = await get(PREVIEW_HOST, path, { headers: c })
      expect(res.status).toBe(404)
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
  })

  it("answers HEAD with the headers and no body", async () => {
    const res = await get(PREVIEW_HOST, "/", {
      method: "HEAD",
      headers: cookie(await claimFor()),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await res.text()).toBe("")
  })

  it("does not serve another org's revision to a claim naming it", async () => {
    // Org A's claim naming org B's revision: no manifest under A's prefix.
    const crossSite = await claimFor({ revision_id: OTHER_REV })
    expect(
      (await get(PREVIEW_HOST, "/", { headers: cookie(crossSite) })).status
    ).toBe(404)
    // Org A's claim naming org B's site and revision: the manifest is B's.
    const crossOrg = await claimFor({ site_id: OTHER, revision_id: OTHER_REV })
    expect(
      (await get(PREVIEW_HOST, "/", { headers: cookie(crossOrg) })).status
    ).toBe(404)
  })

  it("refuses a manifest whose site or revision is not the claim's", async () => {
    const wrongRev = "10000001-0000-4000-8000-000000000005"
    revision(ORG, wrongRev, { revision_id: REV })
    expect(
      (
        await get(PREVIEW_HOST, "/", {
          headers: cookie(await claimFor({ revision_id: wrongRev })),
        })
      ).status
    ).toBe(404)
    const wrongSite = "10000001-0000-4000-8000-000000000006"
    revision(ORG, wrongSite, { site_id: OTHER })
    expect(
      (
        await get(PREVIEW_HOST, "/", {
          headers: cookie(await claimFor({ revision_id: wrongSite })),
        })
      ).status
    ).toBe(404)
  })
})

describe("a published host", () => {
  const pointer = {
    org_id: ORG,
    site_id: ORG,
    revision_id: REV,
    config_version: 2,
  }

  it("answers 404 on a KV miss and on a pointer that does not parse", async () => {
    expect((await get(SITE_HOST, "/")).status).toBe(404)
    pointers.set(`host:${SITE_HOST}`, { revision_id: REV })
    expect((await get(SITE_HOST, "/")).status).toBe(404)
    pointers.delete(`host:${SITE_HOST}`)
  })

  it("serves the pointed revision with the manifest's headers and caching by class", async () => {
    pointers.set(`host:${SITE_HOST}`, pointer)
    const home = await get(SITE_HOST, "/")
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("0003")
    expect(Object.fromEntries(home.headers)).toMatchObject({
      ...HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    })
    const css = await get(SITE_HOST, "/_astro/index.C1.css")
    expect(css.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    )
    expect((await get(SITE_HOST, "/contact")).status).toBe(200)
    const head = await get(SITE_HOST, "/contact/", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  it("serves nothing the manifest does not list, screenshots included", async () => {
    pointers.set(`host:${SITE_HOST}`, pointer)
    for (const path of [
      "/screenshots/home-390.png",
      "/manifest.json",
      "/source.tar.zst",
      "/dist/index.html",
      "/nope/",
    ]) {
      expect((await get(SITE_HOST, path)).status).toBe(404)
    }
  })

  it("refuses a pointer whose manifest belongs to another org or revision", async () => {
    pointers.set(`host:${SITE_HOST}`, { ...pointer, org_id: OTHER })
    expect((await get(SITE_HOST, "/")).status).toBe(404)
    pointers.set(`host:${SITE_HOST}`, { ...pointer, revision_id: OTHER_REV })
    expect((await get(SITE_HOST, "/")).status).toBe(404)
  })

  it("lets a manifest set neither the type nor the caching", async () => {
    const rev = "10000001-0000-4000-8000-000000000007"
    revision(ORG, rev, {
      headers: {
        "cache-control": "public, max-age=999",
        "content-type": "text/plain",
      },
    })
    pointers.set(`host:${SITE_HOST}`, { ...pointer, revision_id: rev })
    const res = await get(SITE_HOST, "/")
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  })
})
