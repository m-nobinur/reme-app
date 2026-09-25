import { signPreview } from "@workspace/gates/preview"
import { afterEach, describe, expect, it, vi } from "vitest"
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
const ROLLED_BACK_TO = "10000001-0000-4000-8000-000000000009"
const PREVIEW_HOST = `preview-v3-brightclean${SUFFIX}`
const SITE_HOST = `brightclean${SUFFIX}`
const HEADERS = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
}

const objects = new Map<string, string>()
/** Every key R2 was asked for, so a test can say what a request cost. */
const reads: string[] = []
/** Flipped by a test to stand in for an address that has used its askings. */
let limited = false
/** Every key the limiter was asked about. */
const askers: string[] = []
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
      reads.push(key)
      const body = objects.get(key)
      return body === undefined ? null : { body, httpEtag: `"${key}"` }
    },
  },
  MISSES: {
    limit: async ({ key }: { key: string }) => {
      askers.push(key)
      return { success: !limited }
    },
  },
  ROUTES: {
    get: async (key: string) => pointers.get(key) ?? null,
    put: async (key: string, value: string) => {
      pointers.set(key, JSON.parse(value))
    },
  },
  HYPERDRIVE: { connectionString: "postgres://stub" },
} as unknown as Env

const soon = () => Math.floor(Date.now() / 1000) + 3600
const claimFor = (overrides: Record<string, unknown> = {}) =>
  signPreview(
    {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      host: PREVIEW_HOST,
      scope: "site",
      exp: soon(),
      ...overrides,
    } as never,
    KEY
  )
const cookie = (token: string) => ({ cookie: `reme_preview=${token}` })
const get = (host: string, path: string, init: RequestInit = {}) =>
  app.request(`https://${host}${path}`, init, env)

/**
 * Production's environment (issue #90): the route is the whole zone, so the
 * suffix matches every hostname in it and the service names have to be listed.
 * The same bindings otherwise, so a difference here is the environment's.
 */
const PROD_SUFFIX = ".remeai.co.uk"
const prodEnv = {
  ...env,
  SITE_HOST_SUFFIX: PROD_SUFFIX,
  SERVICE_HOSTS:
    "remeai.co.uk,www.remeai.co.uk,api.remeai.co.uk,preview.remeai.co.uk,orchestrator.remeai.co.uk",
} as unknown as Env

/**
 * `fetch` stands in for Cloudflare's own routing: a passthrough is the request
 * leaving this Worker unchanged, so the stub records it and answers 299, a
 * status nothing else in the router returns.
 */
async function passedThrough(
  host: string,
  path: string,
  environment: Env = prodEnv
) {
  const seen: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(typeof input === "string" ? input : (input as Request).url)
    return new Response("passed", { status: 299 })
  }) as typeof fetch
  try {
    const res = await app.request(`https://${host}${path}`, {}, environment)
    return { res, seen }
  } finally {
    globalThis.fetch = real
  }
}

/**
 * A data centre's cache as a map, with the one behaviour of the real one the
 * router leans on: a matching `If-None-Match` is answered 304 with no body.
 */
function withEdgeCache() {
  const stored = new Map<string, Response>()
  // An HTTP cache never sees a fragment, so two keys that differ only after a
  // `#` are one entry. Node's `Request` keeps it; this drops it, as the real
  // cache does.
  const keyOf = (at: Request | string) => {
    const parsed = new URL(typeof at === "string" ? at : at.url)
    parsed.hash = ""
    return parsed.href
  }
  ;(globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (key: Request | string) => {
        const request = new Request(key)
        const hit = stored.get(keyOf(request))?.clone()
        if (!hit) return undefined
        const tag = request.headers.get("if-none-match")
        return tag && tag === hit.headers.get("etag")
          ? new Response(null, { status: 304, headers: hit.headers })
          : hit
      },
      // As the real one: nothing is kept without a lifetime to keep it for.
      put: async (at: string, response: Response) => {
        const lifetime = response.headers.get("cache-control") ?? ""
        if (/max-age=[1-9]/.test(lifetime)) stored.set(keyOf(at), response)
      },
    },
  }
  return stored
}

afterEach(() => {
  ;(globalThis as { caches?: unknown }).caches = undefined
  limited = false
  reads.length = 0
  askers.length = 0
})

/** The router in a new isolate: the edge cache is as it was, the manifests kept in memory are gone. */
async function newIsolate() {
  vi.resetModules()
  const fresh = (await import("../src/index.ts")).default
  return (host: string, path: string, init: RequestInit = {}) =>
    fresh.request(`https://${host}${path}`, init, env)
}

describe("the edge cache", () => {
  const point = (revisionId: string, version: number) =>
    pointers.set(`host:${SITE_HOST}`, {
      org_id: ORG,
      site_id: ORG,
      revision_id: revisionId,
      config_version: version,
    })

  it("serves a second request without reading R2", async () => {
    withEdgeCache()
    point(REV, 1)
    expect((await get(SITE_HOST, "/")).status).toBe(200)
    expect(reads).toHaveLength(2)
    reads.length = 0
    const again = await get(SITE_HOST, "/")
    expect(await again.text()).toBe(`<h1>${REV.slice(-4)}</h1>`)
    expect(again.headers.get("cache-control")).toBe("no-cache")
    expect(again.headers.get("x-frame-options")).toBe("DENY")
    expect(reads).toEqual([])
  })

  it("shows a rollback at once, with the old revision still cached", async () => {
    withEdgeCache()
    revision(ORG, ROLLED_BACK_TO)
    point(REV, 2)
    await get(SITE_HOST, "/")
    point(ROLLED_BACK_TO, 1)
    const after = await get(SITE_HOST, "/")
    expect(await after.text()).toBe(`<h1>${ROLLED_BACK_TO.slice(-4)}</h1>`)
  })

  it("keys on the file the manifest resolved, never on the query", async () => {
    const stored = withEdgeCache()
    point(REV, 1)
    await get(SITE_HOST, "/")
    const size = stored.size
    reads.length = 0
    await get(SITE_HOST, "/?bust=1")
    await get(SITE_HOST, "/index.html?bust=2")
    expect(stored.size).toBe(size)
    expect(reads).toEqual([])
  })

  it("answers a matching validator 304 with no body", async () => {
    withEdgeCache()
    point(REV, 1)
    const etag = (await get(SITE_HOST, "/")).headers.get("etag") as string
    expect(etag).toBeTruthy()
    const res = await get(SITE_HOST, "/", {
      headers: { "if-none-match": etag },
    })
    expect(res.status).toBe(304)
    expect(await res.text()).toBe("")
    expect(res.headers.get("cache-control")).toBe("no-cache")
  })

  it("keeps a validator away from the manifest", async () => {
    withEdgeCache()
    point(REV, 1)
    // One isolate puts the manifest in the cache; the next reads it from
    // there with the visitor's header in hand.
    await (await newIsolate())(SITE_HOST, "/")
    const res = await (await newIsolate())(SITE_HOST, "/", {
      headers: { "if-none-match": `"sites/${ORG}/${REV}/manifest.json"` },
    })
    expect(res.status).toBe(200)
  })

  it("never stores a preview, manifest included", async () => {
    const stored = withEdgeCache()
    const res = await (await newIsolate())(PREVIEW_HOST, "/", {
      headers: cookie(await claimFor()),
    })
    expect(res.status).toBe(200)
    expect(stored.size).toBe(0)
  })

  it("answers HEAD from the cache with no body", async () => {
    withEdgeCache()
    point(REV, 1)
    const cold = await get(SITE_HOST, "/", { method: "HEAD" })
    expect(cold.status).toBe(200)
    expect(await cold.text()).toBe("")
    await get(SITE_HOST, "/")
    reads.length = 0
    const warm = await get(SITE_HOST, "/", { method: "HEAD" })
    expect(warm.headers.get("etag")).toBeTruthy()
    expect(await warm.text()).toBe("")
    expect(reads).toEqual([])
  })

  it("files a name with a fragment in it under its own key", async () => {
    withEdgeCache()
    const id = "10000001-0000-4000-8000-00000000000a"
    revision(ORG, id, {
      files: {
        "index.html": "a".repeat(64),
        "_astro/x": "b".repeat(64),
        "_astro/x#y": "c".repeat(64),
      },
    })
    objects.set(`sites/${ORG}/${id}/dist/_astro/x`, "plain")
    objects.set(`sites/${ORG}/${id}/dist/_astro/x#y`, "fragment")
    point(id, 3)
    expect(await (await get(SITE_HOST, "/_astro/x%23y")).text()).toBe(
      "fragment"
    )
    expect(await (await get(SITE_HOST, "/_astro/x")).text()).toBe("plain")
  })
})

describe("the way to Postgres", () => {
  it("refuses a name that is not one label before reading anything", async () => {
    for (const host of [
      `a.b${SUFFIX}`,
      `-lead${SUFFIX}`,
      `${"x".repeat(64)}${SUFFIX}`,
    ]) {
      const res = await get(host, "/")
      expect(res.status).toBe(404)
    }
    expect(reads).toEqual([])
  })

  it("answers 429 without asking when the address has used its askings", async () => {
    limited = true
    const res = await get(`nobody${SUFFIX}`, "/")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("60")
  })

  it("never asks the limiter about a host KV holds a pointer for", async () => {
    pointers.set(`host:${SITE_HOST}`, {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 1,
    })
    limited = true
    expect((await get(SITE_HOST, "/")).status).toBe(200)
    expect(askers).toEqual([])
  })

  it("counts one IPv6 customer as one asker, however the address is written", async () => {
    limited = true
    for (const ip of [
      "2001:db8:0:12::1",
      "2001:db8:0:12:ffff:ffff:ffff:ffff",
      "2001:0db8::12:0:0:0:9",
      "203.0.113.7",
    ]) {
      await get(`nobody${SUFFIX}`, "/", { headers: { "cf-connecting-ip": ip } })
    }
    expect(askers).toEqual([
      "2001:db8:0:12",
      "2001:db8:0:12",
      "2001:db8:0:12",
      "203.0.113.7",
    ])
  })

  it("believes a cached nobody without asking again", async () => {
    const stored = withEdgeCache()
    stored.set(`https://nobody${SUFFIX}/.edge/nobody`, new Response(null))
    limited = true
    expect((await get(`nobody${SUFFIX}`, "/")).status).toBe(404)
  })
})

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

  it("hands every production service hostname back to Cloudflare, unchanged", async () => {
    for (const host of [
      "api.remeai.co.uk",
      "orchestrator.remeai.co.uk",
      "preview.remeai.co.uk",
      "www.remeai.co.uk",
    ]) {
      const { res, seen } = await passedThrough(host, "/health")
      expect(res.status, host).toBe(299)
      expect(seen, host).toEqual([`https://${host}/health`])
    }
  })

  it("passes a service hostname through before it can read as a tenant site", async () => {
    // The whole reason the list exists: on production every service hostname
    // also ends in the suffix, and a pointer under that name would otherwise
    // be served as somebody's site.
    pointers.set("host:api.remeai.co.uk", {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 1,
    })
    const { res, seen } = await passedThrough("api.remeai.co.uk", "/")
    expect(res.status).toBe(299)
    expect(seen).toEqual(["https://api.remeai.co.uk/"])
    pointers.delete("host:api.remeai.co.uk")
  })

  it("serves a production tenant site rather than passing it through", async () => {
    pointers.set("host:brightclean.remeai.co.uk", {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 1,
    })
    const { res, seen } = await passedThrough("brightclean.remeai.co.uk", "/")
    expect(res.status).toBe(200)
    expect(seen).toEqual([])
    expect(await res.text()).toContain("<h1>")
    pointers.delete("host:brightclean.remeai.co.uk")
  })

  it("answers a published production site's missing path as its own 404", async () => {
    // A pointer that resolves is this site's request: a path it does not have
    // is its 404, never another name's problem.
    pointers.set("host:brightclean.remeai.co.uk", {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 1,
    })
    const { res, seen } = await passedThrough("brightclean.remeai.co.uk", "/no")
    expect(res.status).toBe(404)
    expect(seen).toEqual([])
    pointers.delete("host:brightclean.remeai.co.uk")
  })

  it("passes nothing through on staging, which owns no service hostname", async () => {
    const { res, seen } = await passedThrough(
      "staging-api.remeai.co.uk",
      "/",
      env
    )
    expect(res.status).toBe(404)
    expect(seen).toEqual([])
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

  it("answers 404 on a pointer that does not parse", async () => {
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

// A KV miss reads Postgres and writes the pointer back (§11.1.3). The rows
// are written under `withOrg`, the way the publisher writes them.
const { deployments, orgs, siteRevisions, staff, assignments, tenancy } =
  await import("@workspace/db")
const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)

live("a published host, against a real database", () => {
  it("serves the newest deployment on a KV miss and caches the pointer", async () => {
    const kit = tenancy(url ?? "postgres://unused")
    const orgId = crypto.randomUUID()
    const slug = `router-test-${orgId.slice(0, 8)}`
    const revisionId = crypto.randomUUID()
    await kit.withOrg({ orgId }, async (db) => {
      await db
        .insert(orgs)
        .values({ id: orgId, slug, name: "Router probe (fixture)" })
      const [dev] = await db
        .insert(staff)
        .values({
          orgId,
          staffCode: "DEV-001",
          displayName: "Dev",
          kind: "agent",
          status: "active",
        })
        .returning({ id: staff.id })
      const [assignment] = await db
        .insert(assignments)
        .values({
          orgId,
          staffId: dev?.id ?? orgId,
          createdByStaffId: dev?.id ?? orgId,
          kind: "site.build",
          goal: "probe",
          acceptanceCriteria: ["probe"],
          factSnapshotId: crypto.randomUUID(),
          budgetUsd: 1,
          idempotencyKey: crypto.randomUUID(),
        })
        .returning({ id: assignments.id })
      const prefix = `sites/${orgId}/${revisionId}/`
      await db.insert(siteRevisions).values({
        id: revisionId,
        orgId,
        siteId: orgId,
        assignmentId: assignment?.id ?? orgId,
        version: 1,
        sourceKey: `${prefix}source.tar.zst`,
        artifactPrefix: `${prefix}dist/`,
        manifestKey: `${prefix}manifest.json`,
        status: "published",
      })
      await db.insert(deployments).values({
        orgId,
        siteId: orgId,
        revisionId,
        configVersion: 1,
        kind: "rollback",
        reason: "probe",
      })
    })
    await kit.close()
    revision(orgId, revisionId)
    const host = `${slug}${SUFFIX}`
    const liveEnv = {
      ...env,
      HYPERDRIVE: { connectionString: url },
    } as unknown as Env
    expect(pointers.has(`host:${host}`)).toBe(false)
    const res = await app.request(`https://${host}/`, {}, liveEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(revisionId.slice(-4))
    expect(pointers.get(`host:${host}`)).toMatchObject({
      org_id: orgId,
      site_id: orgId,
      revision_id: revisionId,
      config_version: 1,
    })
    // A slug no business holds is a miss that writes nothing.
    const nobody = await app.request(
      `https://nobody-here${SUFFIX}/`,
      {},
      liveEnv
    )
    expect(nobody.status).toBe(404)
    expect(pointers.has(`host:nobody-here${SUFFIX}`)).toBe(false)

    // KV can go on answering "no pointer" for a minute after the write-back,
    // and a page is many requests. What Postgres said is believed meanwhile,
    // so an asker with nothing left is still served, and told 404 not 429.
    const stored = withEdgeCache()
    pointers.delete(`host:${host}`)
    await app.request(`https://${host}/`, {}, liveEnv)
    await app.request(`https://nobody-here${SUFFIX}/`, {}, liveEnv)
    pointers.delete(`host:${host}`)
    limited = true
    const served = await app.request(`https://${host}/`, {}, liveEnv)
    expect(served.status).toBe(200)
    const refused = await app.request(
      `https://nobody-here${SUFFIX}/`,
      {},
      liveEnv
    )
    expect(refused.status).toBe(404)
    expect([...stored.keys()]).toEqual(
      expect.arrayContaining([
        `https://${host}/.edge/pointer`,
        `https://nobody-here${SUFFIX}/.edge/nobody`,
      ])
    )
  })

  // The other half of issue #90: the same miss, on the environment whose route
  // is the whole zone. Nothing here was ever published under that name, so it
  // is another name's request and goes back to Cloudflare rather than 404.
  it("passes a production host through when no business holds the slug", async () => {
    const host = `nobody-here${PROD_SUFFIX}`
    const { res, seen } = await passedThrough(host, "/", {
      ...prodEnv,
      HYPERDRIVE: { connectionString: url },
    } as unknown as Env)
    expect(res.status).toBe(299)
    expect(seen).toEqual([`https://${host}/`])
    expect(pointers.has(`host:${host}`)).toBe(false)
  })
})
