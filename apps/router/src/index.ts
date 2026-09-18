import {
  DeploymentManifest,
  type ErrorEnvelope,
  SitePointer,
} from "@workspace/contracts"
import { deployments, resolveOrgBySlug, sql, tenancy } from "@workspace/db"
import { resolveSitePath } from "@workspace/gates"
import {
  PREVIEW_COOKIE,
  previewHeaders,
  resolvePreviewPath,
  verifyPreview,
} from "@workspace/gates/preview"
import { type Context, Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"

/**
 * The site router (C6, ADR-030, ADR-032): every tenant site and every
 * preview, one Worker, routed by hostname. A published host is a pointer in
 * KV and a read from R2; a preview host is a signed claim and a read from
 * R2. Nothing here reads an org from the request: the org comes out of the
 * pointer or the claim, both written by the orchestrator (§11.1.8). Postgres
 * is asked one thing only, on a pointer miss, and the way to it is narrow.
 */

type Bindings = Env
type App = { Bindings: Bindings }

const NO_STORE = { "cache-control": "no-store" }

/** One constant answer for every host, path or pointer that serves nothing, so a guess learns nothing. */
const notHere = (c: Context<App>) => c.text("No site here.", 404, NO_STORE)

/** One constant answer for every cookie that does not open this preview. No scheme is offered, so no `WWW-Authenticate`. */
const noPreview = (c: Context<App>) =>
  c.text("No preview here. Open a fresh preview link.", 401, NO_STORE)

/** Says nothing about the host, so a guess still learns nothing. */
const tooMany = (c: Context<App>) =>
  c.text("Too many requests.", 429, { ...NO_STORE, "retry-after": "60" })

/** R4: a failure that is ours leaves as the §28.1 envelope. */
const envelope = (
  c: Context<App>,
  status: 501 | 503,
  body: Omit<ErrorEnvelope, "occurred_at">
) =>
  c.json({ ...body, occurred_at: new Date().toISOString() }, status, NO_STORE)

/**
 * What is left of a host once the suffix is off has to be one DNS label. No
 * slug rule is written down anywhere else yet, so this is the loosest one a
 * hostname allows, and it is checked before any binding is read: a name with a
 * dot in it, or one a business could never hold, costs nothing to refuse.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A preview host, by ADR-030's reserved prefix. */
const isPreviewHost = (host: string) => host.startsWith("preview-")

/**
 * The hostnames in the zone that are not tenant sites, each one a Worker
 * behind its own custom domain. Empty on staging, whose route pattern matches
 * no service hostname, and the whole list on production, whose route is the
 * zone (issue #90, ADR-030): there `SITE_HOST_SUFFIX` is `.remeai.co.uk`, so
 * `api.remeai.co.uk` and the rest would otherwise read as tenant hosts.
 */
const serviceHosts = (env: Env) =>
  new Set(
    (env.SERVICE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )

/**
 * Hand the request back to Cloudflare, which routes it by the hostname's own
 * record: a wildcard route beats a custom domain on the same hostname and
 * `fetch(request)` is what reaches the Worker behind it (measured 2026-09-16).
 * A subrequest to a URL on this Worker's own route does not re-enter it.
 *
 * Only ever called where the router has decided the host is not its own, and
 * only where a list of service hostnames says this Worker sits on a route
 * wider than the sites it serves. Staging has no list and answers 404.
 */
const passThrough = (c: Context<App>) => fetch(c.req.raw)

/** A host in the zone that no site here claims: another name's, or nobody's. */
const unserved = (c: Context<App>) =>
  serviceHosts(c.env).size > 0 ? passThrough(c) : notHere(c)

/**
 * Hashed assets are immutable; everything else is revalidated on every
 * request, so a publish or a rollback is visible at once (ADR-032, no purge).
 */
const cacheFor = (file: string) =>
  file.startsWith("_astro/")
    ? "public, max-age=31536000, immutable"
    : "no-cache"

/** Work that outlives the response. Outside a Worker (the route test) there is no execution context, so it is awaited. */
async function later(c: Context<App>, work: Promise<unknown>) {
  let ctx: { waitUntil: (promise: Promise<unknown>) => void } | null = null
  try {
    ctx = c.executionCtx
  } catch {
    ctx = null
  }
  if (ctx) ctx.waitUntil(work)
  else await work
}

/**
 * This data centre's cache, in front of R2 for a published host. Measured on
 * staging 2026-09-18: the router answers in 13 ms when it reads nothing and in
 * 560 ms when it reads a manifest and a file, both from a bucket in WEUR.
 *
 * Every key names a revision, and a revision never changes, so an entry is
 * never stale and nothing is ever purged: a publish or a rollback moves the
 * pointer, the pointer names another revision, and those are other keys
 * (ADR-032). The key is built from the pointer and the file the manifest
 * resolved, never from the request's own path or query, so a visitor cannot
 * choose one. A preview never comes through here: it is one person's.
 */
const edge = () =>
  (globalThis as { caches?: { default?: Cache } }).caches?.default

const edgeKey = (host: string, key: string) => `https://${host}/.edge/${key}`

/** Stored under a lifetime the cache will keep; what the visitor is told is set on the way out. */
const KEEP = "public, max-age=31536000, immutable"

/** How long "no business holds this name" is believed here before Postgres is asked again. */
const NOBODY_FOR = "public, max-age=60"

async function fromR2(
  c: Context<App>,
  // The published host whose cache this may come from, or null for a preview,
  // which is one person's and is never shared.
  host: string | null,
  key: string,
  // The visitor's validator, for the file they asked for and nothing else:
  // with it the cache answers 304 itself, and a manifest read that carried
  // `If-None-Match: *` would come back with no body to parse.
  tag?: string
): Promise<Response | null> {
  const cache = host ? edge() : undefined
  const url = edgeKey(host ?? "preview", key)
  const hit = await cache?.match(
    new Request(url, tag ? { headers: { "if-none-match": tag } } : undefined)
  )
  if (hit) return hit
  const object = await c.env.SITES.get(key)
  if (!object) return null
  const fresh = new Response(object.body, {
    headers: { etag: object.httpEtag, "cache-control": KEEP },
  })
  if (cache) await later(c, cache.put(url, fresh.clone()))
  return fresh
}

/** The revision's manifest, checked against the ids the caller trusts. */
async function manifestFor(
  c: Context<App>,
  host: string | null,
  ids: { org_id: string; site_id: string; revision_id: string }
): Promise<{ manifest: DeploymentManifest; base: string } | null> {
  const base = `sites/${ids.site_id}/${ids.revision_id}/`
  const stored = await fromR2(c, host, `${base}manifest.json`)
  if (!stored) return null
  const parsed = DeploymentManifest.safeParse(await stored.json())
  if (!parsed.success) return null
  const manifest = parsed.data
  if (
    manifest.org_id !== ids.org_id ||
    manifest.site_id !== ids.site_id ||
    manifest.revision_id !== ids.revision_id
  ) {
    return null
  }
  return { manifest, base }
}

async function serve(
  c: Context<App>,
  host: string | null,
  key: string,
  headers: Headers
): Promise<Response> {
  const found = await fromR2(c, host, key, c.req.header("if-none-match"))
  if (!found) return notHere(c)
  const etag = found.headers.get("etag")
  if (etag) headers.set("etag", etag)
  const bodiless = c.req.method === "HEAD" || found.status === 304
  return new Response(bodiless ? null : found.body, {
    status: found.status,
    headers,
  })
}

/**
 * The pointer Postgres would give for a host: the org the slug names, read
 * the way the console resolves one, then its newest deployment under that
 * org's own row security. Null for a slug no business holds or a site that
 * was never published. Read on a KV miss only, so the hot path never opens
 * a connection.
 */
async function pointerFromTruth(
  c: Context<App>,
  host: string
): Promise<SitePointer | null> {
  const slug = host.slice(0, -c.env.SITE_HOST_SUFFIX.length)
  const kit = tenancy(c.env.HYPERDRIVE.connectionString)
  try {
    const orgId = await resolveOrgBySlug(kit, slug)
    if (!orgId) return null
    const [row] = await kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(deployments)
        .orderBy(sql`${deployments.configVersion} desc`)
        .limit(1)
    )
    if (!row) return null
    return SitePointer.parse({
      org_id: orgId,
      site_id: row.siteId,
      revision_id: row.revisionId,
      config_version: row.configVersion,
    })
  } finally {
    await later(c, kit.close())
  }
}

const app = new Hono<App>()

// Answered before any binding is read. A service hostname is checked first,
// because on production every one of them also ends in `SITE_HOST_SUFFIX` and
// would otherwise be read as a tenant host. What is left is a host this
// environment does not serve: the zone apex among them, which ends in the
// suffix for nobody.
app.use("*", async (c, next) => {
  const host = new URL(c.req.url).hostname
  if (serviceHosts(c.env).has(host)) return passThrough(c)
  if (!host.endsWith(c.env.SITE_HOST_SUFFIX)) return unserved(c)
  if (!LABEL.test(host.slice(0, -c.env.SITE_HOST_SUFFIX.length))) {
    return unserved(c)
  }
  return next()
})

// The site's own API surface arrives with ingest (Phase 3).
app.all("/api/*", (c) =>
  envelope(c, 501, {
    class: "resource",
    code: "route.not_implemented",
    message: "A site's API lands with ingest.",
    detail: {},
  })
)

/**
 * A preview link becomes a cookie scoped to this one host, for the claim's
 * remaining life, and the browser is sent to `/` so the token leaves the
 * address bar and never reaches a `Referer`. A bad link sets nothing.
 */
app.get("/open", async (c) => {
  const host = new URL(c.req.url).hostname
  if (!isPreviewHost(host)) return notHere(c)
  const token = c.req.query("t")
  const claim = await verifyPreview(token, c.env.PREVIEW_KEY)
  if (!claim || !token || claim.host !== host) return noPreview(c)
  setCookie(c, PREVIEW_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.max(0, claim.exp - Math.floor(Date.now() / 1000)),
  })
  return c.redirect("/", 302)
})

app.on(["GET", "HEAD"], "*", async (c) => {
  const url = new URL(c.req.url)
  const host = url.hostname
  if (isPreviewHost(host)) {
    const claim = await verifyPreview(
      getCookie(c, PREVIEW_COOKIE),
      c.env.PREVIEW_KEY
    )
    if (!claim || claim.host !== host) return noPreview(c)
    const found = await manifestFor(c, null, claim)
    if (!found) return notHere(c)
    const resolved = resolvePreviewPath(url.pathname, found.manifest.files)
    if (!resolved) return notHere(c)
    return serve(
      c,
      null,
      `${found.base}${resolved.key}`,
      previewHeaders(found.manifest.headers, resolved.file)
    )
  }
  // KV is the cache and Postgres the truth (§11.1.3): a miss reads the
  // newest deployment for the org the slug names and writes the pointer
  // back. A pointer that does not parse is our bug and is logged as one, and
  // the visitor still sees the same 404.
  const raw = await c.env.ROUTES.get(`host:${host}`, "json")
  let pointer: SitePointer | null = null
  if (raw !== null) {
    const parsed = SitePointer.safeParse(raw)
    if (!parsed.success) {
      console.error(JSON.stringify({ host, code: "pointer.malformed" }))
      return notHere(c)
    }
    pointer = parsed.data
  } else {
    // Postgres is 1.5 to 2.7 s away (measured 2026-09-18) and the zone's
    // wildcard record sends any name here, so the way to it is narrow: a name
    // already found to be nobody's is believed for a minute, and one address
    // gets `MISSES` askings a minute. The second is the control that holds
    // against made-up names, each of which is new to the first.
    const nobody = edgeKey(host, "nobody")
    if (await edge()?.match(nobody)) return unserved(c)
    const { success } = await c.env.MISSES.limit({
      key: c.req.header("cf-connecting-ip") ?? "unknown",
    })
    if (!success) return tooMany(c)
    pointer = await pointerFromTruth(c, host)
    if (pointer) {
      await later(c, c.env.ROUTES.put(`host:${host}`, JSON.stringify(pointer)))
    } else {
      const put = edge()?.put(
        nobody,
        new Response(null, { headers: { "cache-control": NOBODY_FOR } })
      )
      if (put) await later(c, put)
    }
  }
  // No pointer and no row behind it: nothing here was ever published under
  // this name. On production that is another name's request (issue #90); a
  // pointer that resolves and a file that does not is this site's 404, below.
  if (!pointer) return unserved(c)
  const found = await manifestFor(c, host, pointer)
  if (!found) return notHere(c)
  const file = resolveSitePath(url.pathname, found.manifest.files)
  if (!file) return notHere(c)
  return serve(
    c,
    host,
    `${found.base}dist/${file}`,
    previewHeaders(found.manifest.headers, file, cacheFor(file))
  )
})

app.notFound(notHere)

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      host: new URL(c.req.url).hostname,
      code: (error as { code?: string }).code ?? error.name,
    })
  )
  return envelope(c, 503, {
    class: "transient",
    code: "request.failed",
    message: "The request could not be completed.",
    detail: {},
  })
})

export default app
