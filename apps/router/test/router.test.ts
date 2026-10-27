import {
  formatSiteRevision,
  SITE_HEADER,
  SITE_PROBE_HEADER,
  SITE_REVISION_HEADER,
} from "@workspace/contracts"
import { probeProof, signPreview } from "@workspace/gates/preview"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../src/index.ts"

/**
 * Postgres for the cases without one: `postgres://stub` is a database in
 * which every org is open unless `closed` names it, which is all a preview
 * asks. A real URL, in the live cases below, reaches the real kit.
 */
const closed = vi.hoisted(() => new Set<string>())
/**
 * The stub's other rows, for the custom-domain cases, which the shared local
 * database cannot run until it holds migration 0015: an org's slug, its one
 * published revision, and its active domain as `name` and `primary_host`.
 */
const stubbed = vi.hoisted(() => ({
  slugs: new Map<string, string>(),
  revisions: new Map<string, string>(),
  domains: new Map<string, { name: string; primaryHost: string }>(),
}))
vi.mock("@workspace/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace/db")>()
  type Stub = { stubOrg: string }
  const isStub = (db: unknown): db is Stub =>
    typeof db === "object" && db !== null && "stubOrg" in db
  const isStubKit = (kit: unknown) =>
    typeof kit === "object" && kit !== null && "stub" in kit
  // `select().from(t)`, then `orderBy().limit()` or `where()`: the org's
  // slug from `orgs`, its newest deployment from anything else.
  const select = (orgId: string) => () => ({
    from: (table: unknown) => {
      const revisionId = stubbed.revisions.get(orgId)
      const rows =
        table === real.orgs
          ? [{ slug: stubbed.slugs.get(orgId) }]
          : revisionId
            ? [{ siteId: orgId, revisionId, configVersion: 1 }]
            : []
      const query = {
        orderBy: () => query,
        limit: async () => rows,
        where: async () => rows,
      }
      return query
    },
  })
  return {
    ...real,
    tenancy: (connection: string, options?: { max?: number }) =>
      connection === "postgres://stub"
        ? {
            stub: true,
            close: async () => undefined,
            withOrg: async (
              ctx: { orgId: string },
              fn: (db: Stub) => Promise<unknown>
            ) => fn({ stubOrg: ctx.orgId, select: select(ctx.orgId) } as Stub),
          }
        : real.tenancy(connection, options),
    orgOpen: async (db: unknown) =>
      isStub(db) ? !closed.has(db.stubOrg) : real.orgOpen(db as never),
    resolveOrgBySlug: async (kit: unknown, slug: string) =>
      isStubKit(kit)
        ? ([...stubbed.slugs].find(([, s]) => s === slug)?.[0] ?? null)
        : real.resolveOrgBySlug(kit as never, slug),
    resolveDomainHost: async (kit: unknown, host: string) => {
      if (!isStubKit(kit)) return real.resolveDomainHost(kit as never, host)
      const name = host.replace(/^www\./, "")
      const found = [...stubbed.domains].find(([, d]) => d.name === name)
      return found
        ? {
            orgId: found[0],
            siteId: found[0],
            primaryHost: found[1].primaryHost,
          }
        : null
    },
    activeDomainHost: async (db: unknown) =>
      isStub(db)
        ? (stubbed.domains.get(db.stubOrg)?.primaryHost ?? null)
        : real.activeDomainHost(db as never),
  }
})

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
/** The header the publish probe proves itself with, for `host`. */
const probe = async (host: string) => ({
  [SITE_PROBE_HEADER]: await probeProof(host, KEY),
})
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
    // Only that the org is open, which is no one's file.
    expect([...stored.keys()]).toEqual([`https://${PREVIEW_HOST}/.edge/open`])
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

  it("tags a page served from the cache, a 304 and a HEAD", async () => {
    withEdgeCache()
    point(REV, 1)
    const tag = formatSiteRevision({ revision_id: REV, config_version: 1 })
    const proof = await probe(SITE_HOST)
    const cold = await get(SITE_HOST, "/", { headers: proof })
    reads.length = 0
    const warm = await get(SITE_HOST, "/", { headers: proof })
    expect(reads).toEqual([])
    expect(warm.headers.get(SITE_REVISION_HEADER)).toBe(tag)
    const same = await get(SITE_HOST, "/", {
      headers: {
        ...proof,
        "if-none-match": cold.headers.get("etag") as string,
      },
    })
    expect(same.status).toBe(304)
    expect(same.headers.get(SITE_REVISION_HEADER)).toBe(tag)
    const head = await get(SITE_HOST, "/", { method: "HEAD", headers: proof })
    expect(head.headers.get(SITE_REVISION_HEADER)).toBe(tag)
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
      "remeai.co.uk",
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

describe("a custom domain", () => {
  // A business on staging whose slug host has handed over to its own domain:
  // `sparkle.co.uk` is primary and `www.` redirects to it.
  const DOMAIN_ORG = "10000001-0000-4000-8000-000000000005"
  const DOMAIN_REV = "10000001-0000-4000-8000-000000000006"
  const SLUG_HOST = `sparkle${SUFFIX}`
  const DOMAIN = "sparkle.co.uk"
  const baked = `https://${SLUG_HOST}`
  revision(DOMAIN_ORG, DOMAIN_REV, {
    files: {
      "index.html": "a".repeat(64),
      "sitemap-0.xml": "b".repeat(64),
      "robots.txt": "c".repeat(64),
      "_astro/index.C1.css": "d".repeat(64),
    },
  })
  const dist = `sites/${DOMAIN_ORG}/${DOMAIN_REV}/dist/`
  objects.set(
    `${dist}index.html`,
    `<link rel="canonical" href="${baked}/"><meta property="og:url" content="${baked}/"><a href="https://other${SUFFIX}/">a friend</a>`
  )
  objects.set(
    `${dist}sitemap-0.xml`,
    `<loc>${baked}/</loc><loc>${baked}/contact/</loc>`
  )
  objects.set(`${dist}robots.txt`, `Sitemap: ${baked}/sitemap-index.xml`)
  objects.set(`${dist}_astro/index.C1.css`, `/* ${baked} */`)
  const sitePointer = {
    org_id: DOMAIN_ORG,
    site_id: DOMAIN_ORG,
    revision_id: DOMAIN_REV,
    config_version: 1,
  }
  const domainPointer = {
    ...sitePointer,
    canonical_host: DOMAIN,
    origin_host: SLUG_HOST,
  }
  /** The org in the stub database, so a KV miss has a row to find. */
  function inPostgres(domain: boolean) {
    stubbed.slugs.set(DOMAIN_ORG, "sparkle")
    stubbed.revisions.set(DOMAIN_ORG, DOMAIN_REV)
    if (domain) {
      stubbed.domains.set(DOMAIN_ORG, { name: DOMAIN, primaryHost: DOMAIN })
    }
  }
  afterEach(() => {
    for (const map of Object.values(stubbed)) map.clear()
    for (const host of [DOMAIN, `www.${DOMAIN}`, SLUG_HOST]) {
      pointers.delete(`host:${host}`)
    }
  })

  it("serves its pointer and names the domain in canonical, og:url, sitemap and robots", async () => {
    pointers.set(`host:${DOMAIN}`, domainPointer)
    const page = await (await get(DOMAIN, "/")).text()
    expect(page).toBe(
      `<link rel="canonical" href="https://${DOMAIN}/"><meta property="og:url" content="https://${DOMAIN}/"><a href="https://other${SUFFIX}/">a friend</a>`
    )
    expect(await (await get(DOMAIN, "/sitemap-0.xml")).text()).toBe(
      `<loc>https://${DOMAIN}/</loc><loc>https://${DOMAIN}/contact/</loc>`
    )
    expect(await (await get(DOMAIN, "/robots.txt")).text()).toBe(
      `Sitemap: https://${DOMAIN}/sitemap-index.xml`
    )
    // Only the three page types: an asset is served as it was built.
    expect(await (await get(DOMAIN, "/_astro/index.C1.css")).text()).toBe(
      `/* ${baked} */`
    )
  })

  it("leaves a page alone without both hosts in the pointer", async () => {
    pointers.set(`host:${DOMAIN}`, { ...sitePointer, canonical_host: DOMAIN })
    expect(await (await get(DOMAIN, "/")).text()).toContain(`${baked}/`)
  })

  it("gives a rewritten page a weak validator naming the host, and answers it 304", async () => {
    withEdgeCache()
    pointers.set(`host:${DOMAIN}`, domainPointer)
    const first = await get(DOMAIN, "/")
    const tag = first.headers.get("etag")
    expect(tag).toBe(`W/"${dist}index.html:${DOMAIN}"`)
    await first.text()
    const again = await get(DOMAIN, "/", {
      headers: { "if-none-match": tag ?? "" },
    })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe("")
    // The file's own validator is not this representation's.
    const stale = await get(DOMAIN, "/", {
      headers: { "if-none-match": `"${dist}index.html"` },
    })
    expect(stale.status).toBe(200)
  })

  it("sends www to the apex and the slug host to the domain, keeping path and query", async () => {
    pointers.set(`host:www.${DOMAIN}`, { redirect_to: DOMAIN })
    pointers.set(`host:${SLUG_HOST}`, { redirect_to: DOMAIN })
    for (const host of [`www.${DOMAIN}`, SLUG_HOST]) {
      const res = await get(host, "/contact/?ref=card&x=1")
      expect(res.status, host).toBe(301)
      expect(res.headers.get("location"), host).toBe(
        `https://${DOMAIN}/contact/?ref=card&x=1`
      )
      expect(res.headers.get("cache-control"), host).toBe("no-cache")
    }
    expect(reads).toEqual([])
  })

  it("answers a KV miss on the slug host of an org with an active domain with the 301", async () => {
    inPostgres(true)
    const res = await get(SLUG_HOST, "/contact/?a=1")
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe(`https://${DOMAIN}/contact/?a=1`)
    expect(pointers.get(`host:${SLUG_HOST}`)).toEqual({ redirect_to: DOMAIN })
    expect(reads).toEqual([])
  })

  it("still serves the slug host on a KV miss when the org has no domain", async () => {
    inPostgres(false)
    const res = await get(SLUG_HOST, "/")
    expect(res.status).toBe(200)
    expect(pointers.get(`host:${SLUG_HOST}`)).toEqual(sitePointer)
  })

  it("rebuilds a domain's pointers on a KV miss, behind the limiter", async () => {
    inPostgres(true)
    const res = await get(DOMAIN, "/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`href="https://${DOMAIN}/"`)
    expect(pointers.get(`host:${DOMAIN}`)).toEqual(domainPointer)
    const www = await get(`www.${DOMAIN}`, "/?q=1")
    expect(www.status).toBe(301)
    expect(www.headers.get("location")).toBe(`https://${DOMAIN}/?q=1`)
    expect(askers).toHaveLength(2)
    pointers.delete(`host:${DOMAIN}`)
    limited = true
    expect((await get(DOMAIN, "/")).status).toBe(429)
  })

  it("answers 410 for a closed org's domain", async () => {
    inPostgres(true)
    closed.add(DOMAIN_ORG)
    try {
      expect((await get(DOMAIN, "/")).status).toBe(410)
      expect(pointers.has(`host:${DOMAIN}`)).toBe(false)
    } finally {
      closed.delete(DOMAIN_ORG)
    }
  })

  it("answers 404 for an unknown host outside the zone, never passing it through", async () => {
    for (const environment of [env, prodEnv]) {
      const { res, seen } = await passedThrough(
        "unknown.example",
        "/",
        environment
      )
      expect(res.status).toBe(404)
      expect(await res.text()).toBe("No site here.")
      expect(seen).toEqual([])
    }
  })

  it("answers 404 for an unknown host inside the zone on production, never passing it through", async () => {
    for (const host of ["nobody-here.remeai.co.uk", "a.b.remeai.co.uk"]) {
      const { res, seen } = await passedThrough(host, "/")
      expect(res.status, host).toBe(404)
      expect(seen, host).toEqual([])
    }
  })
})

describe("the site header", () => {
  it("names the site on a page and an asset it serves, and on nothing else", async () => {
    pointers.set(`host:${SITE_HOST}`, {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 1,
    })
    expect((await get(SITE_HOST, "/")).headers.get(SITE_HEADER)).toBe(ORG)
    expect(
      (await get(SITE_HOST, "/_astro/index.C1.css")).headers.get(SITE_HEADER)
    ).toBe(ORG)
    // The router's own 404, a path the site lacks, and a preview carry none.
    const lacking = await get(SITE_HOST, "/nope")
    expect(lacking.status).toBe(404)
    expect(lacking.headers.get(SITE_HEADER)).toBeNull()
    const nobody = await get(`nobody${SUFFIX}`, "/")
    expect(nobody.status).toBe(404)
    expect(nobody.headers.get(SITE_HEADER)).toBeNull()
    const preview = await get(PREVIEW_HOST, "/", {
      headers: cookie(await claimFor()),
    })
    expect(preview.status).toBe(200)
    expect(preview.headers.get(SITE_HEADER)).toBeNull()
    pointers.delete(`host:${SITE_HOST}`)
  })
})

describe("a preview host", () => {
  it("treats preview-v<digits>- hosts as previews, whatever the version's length", async () => {
    for (const host of [
      `preview-v1-brightclean${SUFFIX}`,
      `preview-v12-brightclean${SUFFIX}`,
      `preview-v100-brightclean-0b027d88${SUFFIX}`,
    ]) {
      const bare = await get(host, "/")
      expect(bare.status, host).toBe(401)
      expect(bare.headers.get("cache-control")).toBe("no-store")
    }
  })

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

  it("answers 410 for a closed org's preview, and reads no file", async () => {
    closed.add(ORG)
    try {
      const c = cookie(await claimFor())
      for (const path of ["/", "/_astro/index.C1.css"]) {
        const res = await get(PREVIEW_HOST, path, { headers: c })
        expect(res.status, path).toBe(410)
        expect(await res.text()).toBe("This site is no longer available.")
        expect(res.headers.get("cache-control")).toBe("no-store")
      }
      const shots = await claimFor({ scope: "screenshots" })
      const shot = await get(
        PREVIEW_HOST,
        `/screenshots/home-390.png?t=${shots}`
      )
      expect(shot.status).toBe(410)
      expect(reads).toEqual([])
    } finally {
      closed.delete(ORG)
    }
  })

  it("believes a preview's org closed for a minute, without asking again", async () => {
    const stored = withEdgeCache()
    closed.add(ORG)
    const c = cookie(await claimFor())
    expect((await get(PREVIEW_HOST, "/", { headers: c })).status).toBe(410)
    closed.delete(ORG)
    expect([...stored.keys()]).toEqual([`https://${PREVIEW_HOST}/.edge/closed`])
    expect((await get(PREVIEW_HOST, "/", { headers: c })).status).toBe(410)
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

describe("a screenshot link", () => {
  const SHOT = "/screenshots/home-390.png"
  const shots = (overrides: Record<string, unknown> = {}) =>
    claimFor({ scope: "screenshots", ...overrides })

  it("loads a screenshot with ?t= and no cookie, while a page still answers 401", async () => {
    const token = await shots()
    const shot = await get(PREVIEW_HOST, `${SHOT}?t=${token}`)
    expect(shot.status).toBe(200)
    expect(shot.headers.get("content-type")).toBe("image/png")
    expect(shot.headers.get("cache-control")).toBe("private, no-store")
    expect((await get(PREVIEW_HOST, `/?t=${token}`)).status).toBe(401)
    expect(
      (await get(PREVIEW_HOST, "/", { headers: cookie(token) })).status
    ).toBe(401)
    const open = await get(PREVIEW_HOST, `/open?t=${token}`)
    expect(open.status).toBe(401)
    expect(open.headers.get("set-cookie")).toBeNull()
  })

  it("refuses a site claim, another host's claim, an expired one and junk on a screenshot path", async () => {
    for (const token of [
      await claimFor(),
      await shots({ host: `preview-v2-other${SUFFIX}` }),
      await shots({ exp: Math.floor(Date.now() / 1000) - 1 }),
      "junk",
    ]) {
      expect((await get(PREVIEW_HOST, `${SHOT}?t=${token}`)).status).toBe(401)
    }
  })

  it("falls back to the preview cookie when ?t= does not verify", async () => {
    const site = cookie(await claimFor())
    for (const token of [
      "junk",
      await claimFor(),
      await shots({ host: `preview-v2-other${SUFFIX}` }),
    ]) {
      const res = await get(PREVIEW_HOST, `${SHOT}?t=${token}`, {
        headers: site,
      })
      expect(res.status).toBe(200)
      expect((await get(PREVIEW_HOST, `${SHOT}?t=${token}`)).status).toBe(401)
    }
  })

  it("takes ?t= on a preview host only", async () => {
    pointers.set(`host:${SITE_HOST}`, {
      org_id: ORG,
      site_id: ORG,
      revision_id: REV,
      config_version: 2,
    })
    const token = await shots({ host: SITE_HOST })
    expect((await get(SITE_HOST, `${SHOT}?t=${token}`)).status).toBe(404)
    pointers.delete(`host:${SITE_HOST}`)
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

  it("serves a business whose slug starts with preview- as its live site", async () => {
    // "Preview Cleaning" gets `preview-cleaning-<id>` from `slugFor`.
    for (const slug of ["preview-cleaning-0b027d88", "preview-vans-0b027d88"]) {
      const host = `${slug}${SUFFIX}`
      pointers.set(`host:${host}`, pointer)
      const home = await get(host, "/")
      expect(home.status, slug).toBe(200)
      expect(await home.text()).toContain("0003")
    }
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

  it("tags each HTML page with the revision it served by, and no immutable asset", async () => {
    pointers.set(`host:${SITE_HOST}`, pointer)
    const tag = formatSiteRevision(pointer)
    const proof = await probe(SITE_HOST)
    const home = await get(SITE_HOST, "/", { headers: proof })
    expect(home.headers.get(SITE_REVISION_HEADER)).toBe(tag)
    const head = await get(SITE_HOST, "/contact/", {
      method: "HEAD",
      headers: proof,
    })
    expect(head.headers.get(SITE_REVISION_HEADER)).toBe(tag)
    const css = await get(SITE_HOST, "/_astro/index.C1.css", { headers: proof })
    expect(css.headers.get(SITE_REVISION_HEADER)).toBeNull()
  })

  it("names no revision to a visitor, or to a proof made for another host", async () => {
    pointers.set(`host:${SITE_HOST}`, pointer)
    const visitor = await get(SITE_HOST, "/")
    expect(visitor.status).toBe(200)
    expect(visitor.headers.get(SITE_REVISION_HEADER)).toBeNull()
    for (const headers of [
      await probe(`other${SUFFIX}`),
      { [SITE_PROBE_HEADER]: "not-a-proof" },
    ]) {
      const res = await get(SITE_HOST, "/", { headers })
      expect(res.status).toBe(200)
      expect(res.headers.get(SITE_REVISION_HEADER)).toBeNull()
    }
    const unkeyed = await app.request(
      `https://${SITE_HOST}/`,
      { headers: await probe(SITE_HOST) },
      { ...env, PREVIEW_KEY: "" } as unknown as Env
    )
    expect(unkeyed.headers.get(SITE_REVISION_HEADER)).toBeNull()
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
const {
  deployments,
  memberships,
  orgs,
  siteRevisions,
  staff,
  assignments,
  sql,
  tenancy,
  tombstone,
  users,
} = await import("@workspace/db")
const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)

/**
 * A fictional org with one published deployment and its owner, who is still
 * here (`open`), deleted their account (`deleted`, the tombstone
 * `DELETE /account` writes first) or has left (`left`, the membership it
 * ends last).
 */
async function publishedOrg(owner: "open" | "deleted" | "left") {
  const kit = tenancy(url ?? "postgres://unused")
  const orgId = crypto.randomUUID()
  const workosUserId = `user_router_probe_${orgId}`
  const slug = `router-test-${orgId.slice(0, 8)}`
  const revisionId = crypto.randomUUID()
  await kit.withOrg({ orgId, workosUserId }, async (db) => {
    await db
      .insert(orgs)
      .values({ id: orgId, slug, name: "Router probe (fixture)" })
    await db
      .insert(users)
      .values({ workosUserId, email: `router-${orgId}@example.test` })
    const [person] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.workosUserId} = ${workosUserId}`)
    const personId = person?.id as string
    await db.insert(memberships).values({
      orgId,
      userId: personId,
      workosMembershipId: `om_router_probe_${orgId}`,
      role: "owner",
      status: owner === "left" ? "inactive" : "active",
    })
    if (owner === "deleted") {
      await db
        .update(users)
        .set({ email: tombstone(personId) })
        .where(sql`${users.id} = ${personId}`)
    }
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
  return { orgId, slug, revisionId }
}

live("a published host, against a real database", () => {
  const liveEnv = {
    ...env,
    HYPERDRIVE: { connectionString: url },
  } as unknown as Env

  it("serves the newest deployment on a KV miss and caches the pointer", async () => {
    const { orgId, slug, revisionId } = await publishedOrg("open")
    const host = `${slug}${SUFFIX}`
    expect(pointers.has(`host:${host}`)).toBe(false)
    const proof = { headers: await probe(host) }
    const res = await app.request(`https://${host}/`, proof, liveEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(revisionId.slice(-4))
    const tag = formatSiteRevision({
      revision_id: revisionId,
      config_version: 1,
    })
    expect(res.headers.get(SITE_REVISION_HEADER)).toBe(tag)
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
    const served = await app.request(`https://${host}/`, proof, liveEnv)
    expect(served.status).toBe(200)
    // Served from the pointer the edge believed, and tagged from it.
    expect(served.headers.get(SITE_REVISION_HEADER)).toBe(tag)
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

  // The same miss, on the environment whose route is the whole zone. Handed
  // back, the name met the zone's `100::` record and Cloudflare's 522
  // (measured on v0.1.23), so it is this router's 404 there too.
  it("answers 404 for a production host no business holds, passing nothing through", async () => {
    const host = `nobody-here${PROD_SUFFIX}`
    const { res, seen } = await passedThrough(host, "/", {
      ...prodEnv,
      HYPERDRIVE: { connectionString: url },
    } as unknown as Env)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("No site here.")
    expect(seen).toEqual([])
    expect(pointers.has(`host:${host}`)).toBe(false)
  })

  // ADR-035: once the owner deletes their account the takedown removes the
  // pointer, and a miss must not put it back.
  it("answers 410 on a KV miss for a closed org and writes no pointer", async () => {
    for (const owner of ["deleted", "left"] as const) {
      const { slug } = await publishedOrg(owner)
      const host = `${slug}${SUFFIX}`
      const res = await app.request(`https://${host}/`, {}, liveEnv)
      expect(res.status, owner).toBe(410)
      expect(await res.text()).toBe("This site is no longer available.")
      expect(res.headers.get(SITE_REVISION_HEADER)).toBeNull()
      expect(pointers.has(`host:${host}`), owner).toBe(false)
    }
  })

  it("answers 410 for a closed org on production rather than passing it through", async () => {
    const { slug } = await publishedOrg("deleted")
    const host = `${slug}${PROD_SUFFIX}`
    const { res, seen } = await passedThrough(host, "/", {
      ...prodEnv,
      HYPERDRIVE: { connectionString: url },
    } as unknown as Env)
    expect(res.status).toBe(410)
    expect(seen).toEqual([])
    expect(pointers.has(`host:${host}`)).toBe(false)
  })

  it("believes a closed org for a minute, without asking again", async () => {
    const { slug } = await publishedOrg("deleted")
    const host = `${slug}${SUFFIX}`
    const stored = withEdgeCache()
    expect((await app.request(`https://${host}/`, {}, liveEnv)).status).toBe(
      410
    )
    expect([...stored.keys()]).toEqual([`https://${host}/.edge/closed`])
    limited = true
    expect((await app.request(`https://${host}/`, {}, liveEnv)).status).toBe(
      410
    )
  })

  it("leaves the hot path alone: a pointer in KV is served without asking", async () => {
    // The takedown is what removes it; the router never reads Postgres on a hit.
    const { orgId, slug, revisionId } = await publishedOrg("deleted")
    const host = `${slug}${SUFFIX}`
    pointers.set(`host:${host}`, {
      org_id: orgId,
      site_id: orgId,
      revision_id: revisionId,
      config_version: 1,
    })
    limited = true
    const res = await app.request(`https://${host}/`, {}, env)
    expect(res.status).toBe(200)
    expect(askers).toEqual([])
    pointers.delete(`host:${host}`)
  })

  it("answers 410 for a closed org's preview, from the real database", async () => {
    const { orgId, revisionId } = await publishedOrg("deleted")
    const host = `preview-v1-router-closed${SUFFIX}`
    const token = await signPreview(
      {
        org_id: orgId,
        site_id: orgId,
        revision_id: revisionId,
        host,
        scope: "site",
        exp: soon(),
      } as never,
      KEY
    )
    const res = await app.request(
      `https://${host}/`,
      { headers: cookie(token) },
      liveEnv
    )
    expect(res.status).toBe(410)
    const open = await publishedOrg("open")
    const served = await app.request(
      `https://${host}/`,
      {
        headers: cookie(
          await signPreview(
            {
              org_id: open.orgId,
              site_id: open.orgId,
              revision_id: open.revisionId,
              host,
              scope: "site",
              exp: soon(),
            } as never,
            KEY
          )
        ),
      },
      liveEnv
    )
    expect(served.status).toBe(200)
  })
})
