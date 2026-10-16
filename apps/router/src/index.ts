import {
  DeploymentManifest,
  type EnvelopeBody,
  envelope,
  formatSiteRevision,
  isPreviewHost,
  REQUEST_FAILED,
  RedirectPointer,
  SITE_PROBE_HEADER,
  SITE_REVISION_HEADER,
  SitePointer,
  SLUG,
  siteHost,
} from "@workspace/contracts"
import {
  activeDomainHost,
  deployments,
  logFailure,
  orgOpen,
  orgs,
  resolveDomainHost,
  resolveOrgBySlug,
  sql,
  tenancy,
} from "@workspace/db"
import {
  PREVIEW_COOKIE,
  previewHeaders,
  resolvePreviewPath,
  SCREENSHOTS,
  verifyPreview,
  verifyProbe,
} from "@workspace/gates/preview"
import { resolveSitePath } from "@workspace/gates/site-path"
import { type Context, Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"

/**
 * The site router (C6, ADR-030, ADR-032): every tenant site and every
 * preview, one Worker, routed by hostname. A published host is a pointer in
 * KV and a read from R2; a preview host is a signed claim and a read from
 * R2. Nothing here reads an org from the request: the org comes out of the
 * pointer or the claim, both written by the orchestrator (§11.1.8). Postgres
 * is asked on a pointer miss, and whether a preview's org is still open, and
 * the way to it is narrow.
 */

type Bindings = Env
type App = { Bindings: Bindings }

/** What `host:{hostname}` holds: a site to serve, or a host to send visitors on to. */
const Pointer = SitePointer.or(RedirectPointer)
type Pointer = SitePointer | RedirectPointer

/** The zone every Reme hostname is in. Any other host reaches the router as an owner's custom domain (Cloudflare for SaaS). */
const ZONE = "remeai.co.uk"
const inZone = (host: string) => host === ZONE || host.endsWith(`.${ZONE}`)

const NO_STORE = { "cache-control": "no-store" }

/** One constant answer for every host, path or pointer that serves nothing, so a guess learns nothing. */
const notHere = (c: Context<App>) => c.text("No site here.", 404, NO_STORE)

/** One constant answer for every cookie that does not open this preview. No scheme is offered, so no `WWW-Authenticate`. */
const noPreview = (c: Context<App>) =>
  c.text("No preview here. Open a fresh preview link.", 401, NO_STORE)

/**
 * A site, or a preview, whose owner deleted their account (ADR-035). Said
 * only for a name a business held, so it tells a guess no more than a live
 * site would.
 */
const gone = (c: Context<App>) =>
  c.text("This site is no longer available.", 410, NO_STORE)

/** Says nothing about the host, so a guess still learns nothing. */
const tooMany = (c: Context<App>) =>
  c.text("Too many requests.", 429, { ...NO_STORE, "retry-after": "60" })

/** R4: a failure that is ours leaves as the §28.1 envelope. */
const failure = (c: Context<App>, status: 501 | 503, body: EnvelopeBody) =>
  c.json(envelope(body), status, NO_STORE)

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

/**
 * A host no site here claims. In the zone it is another name's, or nobody's;
 * outside it, behind production's route for every host, it is a custom
 * hostname with no pointer, and handing it back would fetch the `100::`
 * fallback origin, so it is 404.
 */
const unserved = (c: Context<App>) =>
  serviceHosts(c.env).size > 0 && inZone(new URL(c.req.url).hostname)
    ? passThrough(c)
    : notHere(c)

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

// Each segment escaped: a file name may hold `#`, `?` or `\`, and a URL would
// otherwise drop or rewrite them and file two objects under one key.
const edgeKey = (host: string, key: string) =>
  `https://${host}/.edge/${key.split("/").map(encodeURIComponent).join("/")}`

/** Stored under a lifetime the cache will keep; what the visitor is told is set on the way out. */
const KEEP = "public, max-age=31536000, immutable"

/** How long an answer from Postgres about a name is believed here before it is asked again. */
const BELIEVED_FOR = "public, max-age=60"

/** Keep what Postgres said about a host: its pointer, that nobody holds it, or whether its org is open. */
async function believe(
  c: Context<App>,
  host: string,
  what: "pointer" | "nobody" | "open" | "closed",
  body: string | null
) {
  const put = edge()?.put(
    edgeKey(host, what),
    new Response(body, { headers: { "cache-control": BELIEVED_FOR } })
  )
  if (put) await later(c, put)
}

/**
 * Who is asking, for the limiter. One IPv6 customer holds a /64, so the whole
 * address would hand them 2^64 keys; the first four groups are the customer.
 * Off Cloudflare there is no header and every request shares one key.
 */
function asker(c: Context<App>): string {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown"
  if (!ip.includes(":")) return ip
  const [head = "", tail = ""] = ip.split("::")
  const front = head ? head.split(":") : []
  const back = tail ? tail.split(":") : []
  const groups = [
    ...front,
    ...new Array(Math.max(0, 8 - front.length - back.length)).fill("0"),
    ...back,
  ]
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")
}

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

/** Parsed manifests for the life of the isolate. A revision never changes, so neither does its manifest. */
const manifests = new Map<string, DeploymentManifest>()

/** The revision's manifest, checked against the ids the caller trusts. */
async function manifestFor(
  c: Context<App>,
  host: string | null,
  ids: { org_id: string; site_id: string; revision_id: string }
): Promise<{ manifest: DeploymentManifest; base: string } | null> {
  const base = `sites/${ids.site_id}/${ids.revision_id}/`
  let manifest = manifests.get(base)
  if (!manifest) {
    const stored = await fromR2(c, host, `${base}manifest.json`)
    if (!stored) return null
    const parsed = DeploymentManifest.safeParse(await stored.json())
    if (!parsed.success) return null
    manifest = parsed.data
    // ponytail: emptied whole at the ceiling; an LRU if one isolate ever
    // serves more live revisions than this.
    if (manifests.size >= 256) manifests.clear()
    manifests.set(base, manifest)
  }
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
  headers: Headers,
  // The slug host the build baked in and the custom domain to name instead.
  rewrite?: { from: string; to: string }
): Promise<Response> {
  // A rewritten body is its own representation, so its validator is the
  // file's, made weak and suffixed with the host; the file's own is what the
  // cache matches.
  const mark = rewrite ? `:${rewrite.to}"` : ""
  let asked = c.req.header("if-none-match")
  if (rewrite) {
    asked =
      asked?.startsWith("W/") && asked.endsWith(mark)
        ? `${asked.slice(2, -mark.length)}"`
        : undefined
  }
  const found = await fromR2(c, host, key, asked)
  if (!found) return notHere(c)
  const etag = found.headers.get("etag")
  if (etag) {
    headers.set("etag", rewrite ? `W/${etag.replace(/"$/, mark)}` : etag)
  }
  const bodiless = c.req.method === "HEAD" || found.status === 304
  // On a miss the body is one half of a tee whose other half fills the cache;
  // left unread it would be buffered whole. Not awaited: a tee's cancel
  // settles only when both halves are done, and the other is still filling.
  if (bodiless) found.body?.cancel().catch(() => undefined)
  // shortcut: the page is read whole to rewrite it; a site's .html, .xml and
  // .txt are kilobytes. Stream with a carry-over if one ever is not.
  const body = bodiless
    ? null
    : rewrite
      ? (await found.text()).replaceAll(
          `https://${rewrite.from}`,
          `https://${rewrite.to}`
        )
      : found.body
  return new Response(body, { status: found.status, headers })
}

/**
 * The pointer Postgres would give for a host. A slug host is the org the slug
 * names, read the way the console resolves one; any other host is an active
 * custom domain, through `resolve_domain_host`. Then, under that org's own row
 * security, its newest deployment. A slug host whose org has an active domain
 * redirects to it, so an evicted KV key never puts the site back on the old
 * address, and a domain's other host redirects to its primary. Null for a
 * name nobody holds or a site never published, and `closed` for an org whose
 * owner deleted their account, published or not. Read on a KV miss only, so
 * the hot path never opens a connection.
 */
async function pointerFromTruth(
  c: Context<App>,
  host: string
): Promise<Pointer | "closed" | null> {
  const suffix = c.env.SITE_HOST_SUFFIX
  const bySlug = host.endsWith(suffix)
  const kit = tenancy(c.env.HYPERDRIVE.connectionString)
  try {
    const domain = bySlug ? null : await resolveDomainHost(kit, host)
    if (domain && domain.primaryHost !== host) {
      return RedirectPointer.parse({ redirect_to: domain.primaryHost })
    }
    const orgId = bySlug
      ? await resolveOrgBySlug(kit, host.slice(0, -suffix.length))
      : (domain?.orgId ?? null)
    if (!orgId) return null
    const found = await kit.withOrg({ orgId }, async (db) => {
      if (!(await orgOpen(db))) return "closed" as const
      const redirectTo = bySlug ? await activeDomainHost(db) : null
      if (redirectTo) return { redirectTo }
      const [newest] = await db
        .select()
        .from(deployments)
        .orderBy(sql`${deployments.configVersion} desc`)
        .limit(1)
      if (!newest) return null
      // The slug host the build baked in, which a custom domain's pages are
      // rewritten from.
      const [org] = domain
        ? await db
            .select({ slug: orgs.slug })
            .from(orgs)
            .where(sql`${orgs.id} = ${orgId}`)
        : []
      return { newest, slug: org?.slug ?? null }
    })
    if (found === "closed" || !found) return found
    if ("redirectTo" in found) {
      return RedirectPointer.parse({ redirect_to: found.redirectTo })
    }
    return SitePointer.parse({
      org_id: orgId,
      site_id: found.newest.siteId,
      revision_id: found.newest.revisionId,
      config_version: found.newest.configVersion,
      ...(domain && found.slug
        ? {
            canonical_host: domain.primaryHost,
            origin_host: siteHost(found.slug, suffix),
          }
        : {}),
    })
  } finally {
    await later(c, kit.close())
  }
}

/**
 * Whether a preview's org is still open. A claim is good for a day and
 * carries no one's say-so after it is signed, so a deleted account's previews
 * are refused here. Believed for a minute either way, like a pointer; a
 * preview is one person's and seldom, so this is the cost of each first
 * request a minute, not of every one.
 */
async function previewOpen(
  c: Context<App>,
  host: string,
  orgId: string
): Promise<boolean> {
  if (await edge()?.match(edgeKey(host, "open"))) return true
  if (await edge()?.match(edgeKey(host, "closed"))) return false
  const kit = tenancy(c.env.HYPERDRIVE.connectionString)
  try {
    const open = await kit.withOrg({ orgId }, orgOpen)
    await believe(c, host, open ? "open" : "closed", null)
    return open
  } finally {
    await later(c, kit.close())
  }
}

const app = new Hono<App>()

// Answered before any binding is read. A service hostname is checked first,
// because on production every one of them also ends in `SITE_HOST_SUFFIX` and
// would otherwise be read as a tenant host. A host in the zone that is not a
// site name is one this environment does not serve: the zone apex among them,
// which ends in the suffix for nobody. A host outside the zone goes on to its
// `host:` pointer as a custom domain.
app.use("*", async (c, next) => {
  const host = new URL(c.req.url).hostname
  const suffix = c.env.SITE_HOST_SUFFIX
  if (serviceHosts(c.env).has(host)) return passThrough(c)
  if (!host.endsWith(suffix)) return inZone(host) ? unserved(c) : next()
  // A name with a dot in it, or one no business could hold, costs nothing.
  if (!SLUG.test(host.slice(0, -suffix.length))) return unserved(c)
  return next()
})

// The site's own API surface arrives with ingest (Phase 3).
app.all("/api/*", (c) =>
  failure(c, 501, {
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
  const claim = await verifyPreview(token, c.env.PREVIEW_KEY, "site")
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

// The catch-all, and the redirect pointer inside it, stay last: a route for a
// specific path (the Search Console plan's `/google*.html` and IndexNow key)
// goes above this line, so it answers on every host an org holds, a host that
// redirects included, where a 301 would cost the owner their verification.
app.on(["GET", "HEAD"], "*", async (c) => {
  const url = new URL(c.req.url)
  const host = url.hostname
  if (isPreviewHost(host)) {
    // A screenshot shows inline in the owner app, which holds no cookie for
    // this host, so the three screenshot paths also take `?t=` with a
    // `screenshots` claim. Every other path, and the cookie, take `site`
    // only, so a screenshot link never opens a page (ADR-032 amendment). A
    // `?t=` that does not open this host's screenshots leaves the cookie to
    // decide, so a stale link in an open preview tab still loads.
    const shot = c.req.query("t")
    const byLink = SCREENSHOTS.has(url.pathname.replace(/^\/+/, ""))
      ? await verifyPreview(shot, c.env.PREVIEW_KEY, "screenshots")
      : null
    const claim =
      byLink?.host === host
        ? byLink
        : await verifyPreview(
            getCookie(c, PREVIEW_COOKIE),
            c.env.PREVIEW_KEY,
            "site"
          )
    if (!claim || claim.host !== host) return noPreview(c)
    if (!(await previewOpen(c, host, claim.org_id))) return gone(c)
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
  // newest deployment for the org the slug or the custom domain names, or the
  // redirect a domain makes, and writes the pointer back, unless the org is
  // closed, which answers 410 and writes nothing. A pointer that does not
  // parse is our bug and is logged as one, and the visitor still sees the
  // same 404.
  const raw = await c.env.ROUTES.get(`host:${host}`, "json")
  let pointer: Pointer | null = null
  if (raw !== null) {
    const parsed = Pointer.safeParse(raw)
    if (!parsed.success) {
      console.error(JSON.stringify({ host, code: "pointer.malformed" }))
      return notHere(c)
    }
    pointer = parsed.data
  } else {
    // Postgres is 1.5 to 2.7 s away (measured 2026-09-18) and the zone's
    // wildcard record sends any name here, so the way to it is narrow. What
    // it last said about a name is believed for a minute, either way: KV can
    // go on answering "no pointer" for that long after the write-back, and a
    // page is many requests, each of which would otherwise spend an asking.
    // Then one asker gets `MISSES` askings a minute, which is the control
    // that holds against made-up names, each of which is new to the first.
    const known = await edge()?.match(edgeKey(host, "pointer"))
    if (known) {
      pointer = Pointer.parse(await known.json())
    } else {
      if (await edge()?.match(edgeKey(host, "nobody"))) return unserved(c)
      if (await edge()?.match(edgeKey(host, "closed"))) return gone(c)
      const { success } = await c.env.MISSES.limit({ key: asker(c) })
      if (!success) return tooMany(c)
      const truth = await pointerFromTruth(c, host)
      if (truth === "closed") {
        await believe(c, host, "closed", null)
        return gone(c)
      }
      pointer = truth
      if (pointer) {
        const found = JSON.stringify(pointer)
        await later(c, c.env.ROUTES.put(`host:${host}`, found))
        await believe(c, host, "pointer", found)
      } else {
        await believe(c, host, "nobody", null)
      }
    }
  }
  // No pointer and no row behind it: nothing here was ever published under
  // this name. On production that is another name's request (issue #90); a
  // pointer that resolves and a file that does not is this site's 404, below.
  if (!pointer) return unserved(c)
  if ("redirect_to" in pointer) {
    // Revalidated like a page, so a browser drops it once the domain goes.
    c.header("cache-control", "no-cache")
    return c.redirect(
      `https://${pointer.redirect_to}${url.pathname}${url.search}`,
      301
    )
  }
  const found = await manifestFor(c, host, pointer)
  if (!found) return notHere(c)
  const file = resolveSitePath(url.pathname, found.manifest.files)
  if (!file) return notHere(c)
  const headers = previewHeaders(found.manifest.headers, file, cacheFor(file))
  // Which version answered a page, so the publisher's probe judges only its
  // own, and told to the probe alone. An immutable asset names its revision
  // in its path already.
  if (
    file.endsWith(".html") &&
    (await verifyProbe(
      c.req.header(SITE_PROBE_HEADER),
      host,
      c.env.PREVIEW_KEY
    ))
  ) {
    headers.set(SITE_REVISION_HEADER, formatSiteRevision(pointer))
  }
  // `astro build --site` baked the slug host into canonicals, `og:url`, the
  // sitemap and robots; on a custom domain those name the domain instead
  // (ADR-032). One exact origin string, so nothing else on the page moves.
  const { origin_host: from, canonical_host: to } = pointer
  const rewrite =
    from && to && /\.(html|xml|txt)$/.test(file) ? { from, to } : undefined
  return serve(c, host, `${found.base}dist/${file}`, headers, rewrite)
})

app.notFound(notHere)

app.onError((error, c) => {
  logFailure({ host: new URL(c.req.url).hostname }, error)
  return failure(c, 503, REQUEST_FAILED)
})

export default app
