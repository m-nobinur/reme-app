import { DeploymentManifest } from "@workspace/contracts"
import { eq, siteRevisions, tenancy } from "@workspace/db"
import { type Context, Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"

/**
 * The preview stand-in (architect ruling on P1): a link the console mints, a
 * cookie the preview host keeps, and a revision's `dist/` served from R2 at
 * the root. Deleted when the router Worker's signed-cookie previews land.
 */

export type PreviewClaim = { org_id: string; revision_id: string; exp: number }

/** How long a preview link and its cookie are good for. */
export const PREVIEW_TTL_S = 24 * 60 * 60

const encoder = new TextEncoder()

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  )

const hmacKey = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [use]
  )

/** `<claim>.<mac>`, both base64url. */
export async function signPreview(
  claim: PreviewClaim,
  secret: string
): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(claim)))
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(body)
  )
  return `${body}.${b64url(new Uint8Array(mac))}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The claim, or null for anything forged, malformed or expired. The MAC is
 * checked with `crypto.subtle.verify`, which compares in constant time.
 */
export async function verifyPreview(
  token: string | undefined,
  secret: string,
  now: number = Date.now()
): Promise<PreviewClaim | null> {
  if (!token || !secret) return null
  const [body, mac, extra] = token.split(".")
  if (!body || !mac || extra !== undefined) return null
  let ok = false
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      fromB64url(mac),
      encoder.encode(body)
    )
  } catch {
    return null
  }
  if (!ok) return null
  try {
    const claim = JSON.parse(new TextDecoder().decode(fromB64url(body)))
    if (
      typeof claim.exp !== "number" ||
      claim.exp * 1000 <= now ||
      !UUID.test(claim.org_id) ||
      !UUID.test(claim.revision_id)
    ) {
      return null
    }
    return {
      org_id: claim.org_id,
      revision_id: claim.revision_id,
      exp: claim.exp,
    }
  } catch {
    return null
  }
}

/** The screenshots `report_complete` stores, reachable by these names only. */
export const SCREENSHOTS = new Set([
  "screenshots/home-390.png",
  "screenshots/home-768.png",
  "screenshots/home-1440.png",
])

/**
 * The R2 key under the revision prefix a request path names, or null. Only a
 * file the manifest lists, or one of the three screenshots, resolves; the
 * source tarball and the manifest itself never do.
 */
export function resolvePreviewPath(
  pathname: string,
  files: Record<string, string>
): { key: string; file: string } | null {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (path.includes("\0") || path.split("/").includes("..")) return null
  const trimmed = path.replace(/^\/+/, "")
  if (SCREENSHOTS.has(trimmed)) return { key: trimmed, file: trimmed }
  const candidates =
    trimmed === "" || trimmed.endsWith("/")
      ? [`${trimmed}index.html`]
      : [trimmed, `${trimmed}/index.html`]
  for (const file of candidates) {
    if (Object.hasOwn(files, file)) return { key: `dist/${file}`, file }
  }
  return null
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  woff: "font/woff",
  woff2: "font/woff2",
}

/** The upload sets no content type, and `nosniff` refuses CSS or JS served without one. */
export const contentType = (file: string) =>
  TYPES[file.split(".").pop()?.toLowerCase() ?? ""] ??
  "application/octet-stream"

/** The manifest's headers, the type, and no caching: nothing else. */
export function previewHeaders(
  manifestHeaders: Record<string, string>,
  file: string
): Headers {
  const headers = new Headers(manifestHeaders)
  headers.set("content-type", contentType(file))
  headers.set("cache-control", "private, no-store")
  return headers
}

/** The cookie the preview host keeps: the signed claim, and nothing else. */
export const PREVIEW_COOKIE = "reme_preview"

type PreviewEnv = { Bindings: Env }

/** Everything the preview host cannot serve is the same 404, so a guess learns nothing. */
const notHere = (c: Context<PreviewEnv>) =>
  c.text("No preview here. Open a preview link from the console.", 404, {
    "cache-control": "no-store",
  })

/**
 * The preview host (architect ruling on P1). `/open` turns a signed link into
 * a cookie and sends the browser to `/`, which also takes the token out of
 * the address bar. Every other request reads the cookie, finds the revision
 * under `withOrg` with the org the server signed, takes the R2 keys from that
 * row, and serves only what the revision's manifest lists, from the root, so
 * the artifact is exactly the one built.
 */
export const previewApp = new Hono<PreviewEnv>()

previewApp.get("/open", async (c) => {
  const token = c.req.query("t")
  const claim = await verifyPreview(token, c.env.PREVIEW_KEY)
  if (!claim || !token) return notHere(c)
  setCookie(c, PREVIEW_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.max(0, claim.exp - Math.floor(Date.now() / 1000)),
  })
  return c.redirect("/", 302)
})

previewApp.on(["GET", "HEAD"], "*", async (c) => {
  const claim = await verifyPreview(
    getCookie(c, PREVIEW_COOKIE),
    c.env.PREVIEW_KEY
  )
  if (!claim) return notHere(c)
  const kit = tenancy(c.env.HYPERDRIVE.connectionString)
  let row: typeof siteRevisions.$inferSelect | undefined
  try {
    ;[row] = await kit.withOrg({ orgId: claim.org_id }, (db) =>
      db
        .select()
        .from(siteRevisions)
        .where(eq(siteRevisions.id, claim.revision_id))
    )
  } finally {
    await kit.close()
  }
  // RLS already hides another org's row; the check says so in code too.
  if (!row || row.orgId !== claim.org_id) return notHere(c)
  const stored = await c.env.SITES.get(row.manifestKey)
  if (!stored) return notHere(c)
  const manifest = DeploymentManifest.parse(await stored.json())
  const resolved = resolvePreviewPath(
    new URL(c.req.url).pathname,
    manifest.files
  )
  if (!resolved) return notHere(c)
  const base = row.manifestKey.replace(/manifest\.json$/, "")
  const object = await c.env.SITES.get(`${base}${resolved.key}`)
  if (!object) return notHere(c)
  return new Response(c.req.method === "HEAD" ? null : object.body, {
    headers: previewHeaders(manifest.headers, resolved.file),
  })
})
