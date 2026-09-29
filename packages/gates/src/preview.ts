import { PreviewClaim } from "@workspace/contracts"
import { resolveSitePath } from "./site-path.ts"

/**
 * The preview seam the orchestrator and the router share (ADR-032): the
 * orchestrator signs a `PreviewClaim` after it resolved the org, the router
 * verifies it and serves only what the revision's manifest lists. One
 * implementation, imported by both, so the two Workers cannot drift on what
 * a token means. Pure over the contract: no binding, no clock of its own.
 */

/** How long a preview link and its cookie are good for. */
export const PREVIEW_TTL_S = 24 * 60 * 60

/** The cookie the preview host keeps: the signed claim, and nothing else. */
export const PREVIEW_COOKIE = "reme_preview"

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
  const body = b64url(encoder.encode(JSON.stringify(PreviewClaim.parse(claim))))
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(body)
  )
  return `${body}.${b64url(new Uint8Array(mac))}`
}

/**
 * The claim, or null for anything forged, malformed, expired or of another
 * scope. The MAC is checked with `crypto.subtle.verify`, which compares in
 * constant time, and the body is checked against the contract, so a claim
 * missing its host or its site never verifies. A claim at exactly `exp` is
 * already expired. A `screenshots` claim never opens a page, and a `site`
 * claim never rides on a screenshot URL (ADR-032 amendment).
 */
export async function verifyPreview(
  token: string | undefined,
  secret: string,
  scope: PreviewClaim["scope"],
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
    // A claim signed before `scope` existed was a site claim. The contract
    // keeps `scope` required, so the default lives here, on the verify side.
    const parsed = PreviewClaim.safeParse({
      scope: "site",
      ...JSON.parse(new TextDecoder().decode(fromB64url(body))),
    })
    if (!parsed.success || parsed.data.exp * 1000 <= now) return null
    return parsed.data.scope === scope ? parsed.data : null
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
 * The R2 key under the revision prefix a preview request path names, or
 * null. Only a file the manifest lists, or one of the three screenshots,
 * resolves; the source tarball and the manifest itself never do.
 */
export function resolvePreviewPath(
  pathname: string,
  files: Record<string, string>
): { key: string; file: string } | null {
  const trimmed = pathname.replace(/^\/+/, "")
  if (SCREENSHOTS.has(trimmed)) return { key: trimmed, file: trimmed }
  const file = resolveSitePath(pathname, files)
  return file ? { key: `dist/${file}`, file } : null
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

/**
 * The manifest's headers, then the type, then the caching, in that order as
 * a rule: a manifest can never set its own content type or cache-control.
 * The default caching is a preview's, private and never stored; a published
 * host overwrites it by asset class.
 */
export function previewHeaders(
  manifestHeaders: Record<string, string>,
  file: string,
  cacheControl = "private, no-store"
): Headers {
  const headers = new Headers(manifestHeaders)
  headers.set("content-type", contentType(file))
  headers.set("cache-control", cacheControl)
  return headers
}
