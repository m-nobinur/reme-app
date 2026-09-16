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
 * R2. Nothing here opens the database and nothing here reads an org from
 * the request: the org comes out of the pointer or the claim, both written
 * by the orchestrator (§11.1.8).
 */

type Bindings = Env
type App = { Bindings: Bindings }

const NO_STORE = { "cache-control": "no-store" }

/** One constant answer for every host, path or pointer that serves nothing, so a guess learns nothing. */
const notHere = (c: Context<App>) => c.text("No site here.", 404, NO_STORE)

/** One constant answer for every cookie that does not open this preview. No scheme is offered, so no `WWW-Authenticate`. */
const noPreview = (c: Context<App>) =>
  c.text(
    "No preview here. Open a preview link from the console.",
    401,
    NO_STORE
  )

/** R4: a failure that is ours leaves as the §28.1 envelope. */
const envelope = (
  c: Context<App>,
  status: 501 | 503,
  body: Omit<ErrorEnvelope, "occurred_at">
) =>
  c.json({ ...body, occurred_at: new Date().toISOString() }, status, NO_STORE)

/** A preview host, by ADR-030's reserved prefix. */
const isPreviewHost = (host: string) => host.startsWith("preview-")

/**
 * Hashed assets are immutable; everything else is revalidated on every
 * request, so a publish or a rollback is visible at once (ADR-032, no purge).
 */
const cacheFor = (file: string) =>
  file.startsWith("_astro/")
    ? "public, max-age=31536000, immutable"
    : "no-cache"

/** The revision's manifest, checked against the ids the caller trusts. */
async function manifestFor(
  sites: R2Bucket,
  ids: { org_id: string; site_id: string; revision_id: string }
): Promise<{ manifest: DeploymentManifest; base: string } | null> {
  const base = `sites/${ids.site_id}/${ids.revision_id}/`
  const stored = await sites.get(`${base}manifest.json`)
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
  key: string,
  headers: Headers
): Promise<Response> {
  const object = await c.env.SITES.get(key)
  if (!object) return notHere(c)
  return new Response(c.req.method === "HEAD" ? null : object.body, {
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
    // Outside a Worker (the route test) there is no execution context.
    let ctx: { waitUntil: (promise: Promise<unknown>) => void } | null = null
    try {
      ctx = c.executionCtx
    } catch {
      ctx = null
    }
    if (ctx) ctx.waitUntil(kit.close())
    else await kit.close()
  }
}

const app = new Hono<App>()

// A host outside this environment's suffix is nobody's: the route pattern
// admits none on staging, and the production router passes them through
// (issue #90). Answered before any binding is read.
app.use("*", async (c, next) => {
  if (!new URL(c.req.url).hostname.endsWith(c.env.SITE_HOST_SUFFIX)) {
    return notHere(c)
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
    const found = await manifestFor(c.env.SITES, claim)
    if (!found) return notHere(c)
    const resolved = resolvePreviewPath(url.pathname, found.manifest.files)
    if (!resolved) return notHere(c)
    return serve(
      c,
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
    pointer = await pointerFromTruth(c, host)
    if (pointer) {
      await c.env.ROUTES.put(`host:${host}`, JSON.stringify(pointer))
    }
  }
  if (!pointer) return notHere(c)
  const found = await manifestFor(c.env.SITES, pointer)
  if (!found) return notHere(c)
  const file = resolveSitePath(url.pathname, found.manifest.files)
  if (!file) return notHere(c)
  return serve(
    c,
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
