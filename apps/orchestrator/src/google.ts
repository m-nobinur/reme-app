/**
 * Google Search Console for an owner's own Google account, over fetch: the
 * OAuth code exchange, refresh and revoke, the refresh token sealed at rest,
 * and the Site Verification and Search Console calls. HTTP and crypto only,
 * no database. Nothing here checks that a `siteUrl` belongs to the org; every
 * caller goes through `search.ts`, which refuses one that is not in the org's
 * `search_properties`.
 *
 * Nothing here logs, and no error carries a token or a code: a failure is a
 * `GoogleError` named by a code and holding the HTTP status, nothing else.
 */

export type GoogleEnv = {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Base64 of 32 random bytes, the AES-256-GCM key for stored refresh tokens. */
  GOOGLE_TOKEN_KEY?: string
}

export const GOOGLE_TIMEOUT_MS = 15_000
/** An access token is refreshed this long before Google says it expires. */
export const REFRESH_EARLY_MS = 5 * 60_000
export const SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/siteverification.verify_only",
] as const

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const VERIFY_API = "https://www.googleapis.com/siteVerification/v1"
const WEBMASTERS_API = "https://www.googleapis.com/webmasters/v3/sites"
const INSPECT_URL =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"

/** A failure the caller logs by code (`failureCode` reads `name`). */
export class GoogleError extends Error {
  constructor(
    code: string,
    readonly status?: number
  ) {
    super(code)
    this.name = code
  }
}

/** The refresh token was revoked or expired: the owner has to connect again. */
export class NeedsReauth extends GoogleError {
  constructor() {
    super("search.needs_reauth", 400)
  }
}

// ---------------------------------------------------------------------------
// The refresh token at rest: "v1.<b64url iv>.<b64url ciphertext+tag>"
// ---------------------------------------------------------------------------

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
/** Standard or url-safe base64, padded or not. */
const unb64 = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  )
const utf8 = (text: string) => new TextEncoder().encode(text)

let imported: { raw: string; key: Promise<CryptoKey> } | undefined

/** Imported once per isolate, again only if the secret itself changes. */
function tokenKey(env: GoogleEnv): Promise<CryptoKey> {
  const raw = env.GOOGLE_TOKEN_KEY
  if (!raw) throw new GoogleError("google.not_configured")
  if (imported?.raw !== raw) {
    let bytes: Uint8Array
    try {
      bytes = unb64(raw)
    } catch {
      throw new GoogleError("google.bad_key")
    }
    if (bytes.length !== 32) throw new GoogleError("google.bad_key")
    imported = {
      raw,
      key: crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    }
  }
  return imported.key
}

/** The org id is the AAD, so a ciphertext copied to another org's row fails. */
export async function sealToken(
  env: GoogleEnv,
  orgId: string,
  refreshToken: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(orgId) },
    await tokenKey(env),
    utf8(refreshToken)
  )
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`
}

export async function openToken(
  env: GoogleEnv,
  orgId: string,
  stored: string
): Promise<string> {
  const key = await tokenKey(env)
  const [version, iv, sealed, extra] = stored.split(".")
  if (version !== "v1" || !iv || !sealed || extra !== undefined) {
    throw new GoogleError("google.bad_token")
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: utf8(orgId) },
      key,
      unb64(sealed)
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw new GoogleError("google.bad_token")
  }
}

// ---------------------------------------------------------------------------
// OAuth: exchange, refresh, revoke
// ---------------------------------------------------------------------------

type TokenResponse = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  id_token?: string
  error?: string
}

const scopesOf = (json: TokenResponse) =>
  (json.scope ?? "").split(" ").filter(Boolean)

/** Google's own error word (`invalid_grant`), never anything it echoed back. */
const errorWord = (json: TokenResponse) =>
  typeof json.error === "string" && /^[a-z_]{1,40}$/.test(json.error)
    ? json.error
    : undefined

async function tokenCall(
  env: GoogleEnv,
  params: Record<string, string>
): Promise<TokenResponse> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleError("google.not_configured")
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  })
  const json = (await response.json().catch(() => ({}))) as TokenResponse
  if (response.ok && json.access_token) return json
  throw new GoogleError(
    `google.${errorWord(json) ?? response.status}`,
    response.status
  )
}

/** Whether a grant carries both Search Console scopes; the consent screen lets an owner untick one. */
export const hasScopes = (scopes: string[]) =>
  SCOPES.every((scope) => scopes.includes(scope))

export type Exchanged = {
  refreshToken: string
  accessToken: string
  /** Seconds, as Google sent it. */
  expiresIn: number
  scopes: string[]
  /** The connected Google account, from the id_token; null without `openid email`. */
  email: string | null
}

/**
 * Trades the callback's code and PKCE verifier for tokens. `scopes` is what
 * Google granted, which may be short of `SCOPES`: the caller decides what a
 * partial grant means (`hasScopes`).
 */
export async function exchangeCode(
  env: GoogleEnv,
  input: { code: string; verifier: string; redirect_uri: string }
): Promise<Exchanged> {
  const json = await tokenCall(env, {
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirect_uri,
    grant_type: "authorization_code",
  })
  const scopes = scopesOf(json)
  // Only with access_type=offline and prompt=consent, which /api/google/start sends.
  if (!json.refresh_token) throw new GoogleError("google.no_refresh_token")
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token as string,
    expiresIn: json.expires_in ?? 3600,
    scopes,
    email: emailOf(json.id_token),
  }
}

/**
 * The id_token came straight from Google's token endpoint over TLS, so its
 * payload is read without checking the signature (OpenID Connect 3.1.3.7).
 */
function emailOf(idToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(unb64(idToken?.split(".")[1] ?? ""))
    ) as { email?: unknown }
    return typeof payload.email === "string" ? payload.email : null
  } catch {
    return null
  }
}

/**
 * Access tokens are never stored: they live here for their hour. Keyed by
 * org and checked against the stored value, so a reconnect to another Google
 * account never reuses the old account's token.
 */
const access = new Map<
  string,
  { stored: string; token: string; scopes: string[]; exp: number }
>()

/**
 * An access token for the org, refreshed 5 minutes before it expires, with
 * the scopes the grant carries now (Google's refresh answer names them; its
 * tokeninfo endpoint is documented for ID tokens only).
 * `invalid_grant` throws `NeedsReauth`. When Google rotates the refresh token,
 * `sealed` is the new value to write to `search_connections.refresh_token`.
 */
export async function accessFor(
  env: GoogleEnv,
  orgId: string,
  stored: string
): Promise<{ accessToken: string; scopes: string[]; sealed?: string }> {
  const cached = access.get(orgId)
  if (cached?.stored === stored && cached.exp - REFRESH_EARLY_MS > Date.now()) {
    return { accessToken: cached.token, scopes: cached.scopes }
  }
  const refreshToken = await openToken(env, orgId, stored)
  let json: TokenResponse
  try {
    json = await tokenCall(env, {
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    })
  } catch (error) {
    access.delete(orgId)
    // On a refresh, and only there, it means the grant is gone.
    if ((error as Error).name === "google.invalid_grant")
      throw new NeedsReauth()
    throw error
  }
  const sealed =
    json.refresh_token && json.refresh_token !== refreshToken
      ? await sealToken(env, orgId, json.refresh_token)
      : undefined
  const accessToken = json.access_token as string
  const scopes = scopesOf(json)
  access.set(orgId, {
    stored: sealed ?? stored,
    token: accessToken,
    scopes,
    exp: Date.now() + (json.expires_in ?? 3600) * 1000,
  })
  return sealed ? { accessToken, scopes, sealed } : { accessToken, scopes }
}

/**
 * Revokes the grant at Google. A token Google already reads as invalid
 * (revoked, expired) counts as done.
 */
export async function revokeToken(token: string): Promise<void> {
  const response = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  })
  if (response.ok) return
  const json = (await response.json().catch(() => ({}))) as TokenResponse
  if (errorWord(json) === "invalid_token") return
  throw new GoogleError(`google.revoke_${response.status}`, response.status)
}

// ---------------------------------------------------------------------------
// Site Verification and Search Console, under the owner's access token
// ---------------------------------------------------------------------------

async function google<T>(
  accessToken: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  })
  // Google's own outage or a quota: a retry may succeed.
  if (response.status >= 500 || response.status === 429) {
    throw new GoogleError("google.unavailable", response.status)
  }
  if (!response.ok) {
    throw new GoogleError(`google.${response.status}`, response.status)
  }
  // sites.add and sitemaps.submit answer with an empty body.
  return (await response.json().catch(() => ({}))) as T
}

/** FILE verifies a URL-prefix `SITE`; DNS_TXT verifies an `INET_DOMAIN`. */
export type VerifyMethod = "FILE" | "DNS_TXT"
const siteOf = (identifier: string, method: VerifyMethod) => ({
  type: method === "FILE" ? "SITE" : "INET_DOMAIN",
  identifier,
})

/**
 * The token to place: for FILE the file name (`google1a2b….html`), served with
 * the body `google-site-verification: {token}`; for DNS_TXT the TXT value.
 * `identifier` is `https://{host}/` for FILE, the bare domain for DNS_TXT.
 */
export async function verificationToken(
  accessToken: string,
  identifier: string,
  method: VerifyMethod
): Promise<string> {
  const { token } = await google<{ token?: string }>(
    accessToken,
    "POST",
    `${VERIFY_API}/token`,
    { site: siteOf(identifier, method), verificationMethod: method }
  )
  if (!token) throw new GoogleError("google.no_token")
  return token
}

/** Asks Google to check the placed token now. Google answers 400 while it cannot find it. */
export function verifyResource(
  accessToken: string,
  identifier: string,
  method: VerifyMethod
): Promise<{ id?: string; owners?: string[] }> {
  return google(
    accessToken,
    "POST",
    `${VERIFY_API}/webResource?verificationMethod=${method}`,
    { site: siteOf(identifier, method) }
  )
}

/**
 * The account's role on a property, as Search Console names it. Google
 * answers 403 or 404 for a property the account no longer has.
 */
export function getSite(
  accessToken: string,
  siteUrl: string
): Promise<{ permissionLevel?: string }> {
  return google(
    accessToken,
    "GET",
    `${WEBMASTERS_API}/${encodeURIComponent(siteUrl)}`
  )
}

/** `siteUrl` is `https://{host}/` or `sc-domain:{domain}`. Idempotent. */
export async function addSite(
  accessToken: string,
  siteUrl: string
): Promise<void> {
  await google(
    accessToken,
    "PUT",
    `${WEBMASTERS_API}/${encodeURIComponent(siteUrl)}`
  )
}

export async function submitSitemap(
  accessToken: string,
  siteUrl: string,
  feedpath: string
): Promise<void> {
  await google(
    accessToken,
    "PUT",
    `${WEBMASTERS_API}/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`
  )
}

/** A sitemap as Google reports it; the numbers in `contents` arrive as strings. */
export type Sitemap = {
  path: string
  lastSubmitted?: string
  lastDownloaded?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  type?: string
  warnings?: string
  errors?: string
  contents?: Array<{ type?: string; submitted?: string; indexed?: string }>
}

export async function listSitemaps(
  accessToken: string,
  siteUrl: string
): Promise<Sitemap[]> {
  const { sitemap } = await google<{ sitemap?: Sitemap[] }>(
    accessToken,
    "GET",
    `${WEBMASTERS_API}/${encodeURIComponent(siteUrl)}/sitemaps`
  )
  return sitemap ?? []
}

export type AnalyticsQuery = {
  /** YYYY-MM-DD in Pacific time, both inclusive. */
  startDate: string
  endDate: string
  dimensions?: Array<"date" | "query" | "page" | "country" | "device">
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews"
  rowLimit?: number
  startRow?: number
  dataState?: "final" | "all"
}
export type AnalyticsRow = {
  keys?: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export async function searchAnalytics(
  accessToken: string,
  siteUrl: string,
  query: AnalyticsQuery
): Promise<{ rows: AnalyticsRow[]; firstIncompleteDate?: string }> {
  const json = await google<{
    rows?: AnalyticsRow[]
    metadata?: { first_incomplete_date?: string }
  }>(
    accessToken,
    "POST",
    `${WEBMASTERS_API}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    query
  )
  return {
    rows: json.rows ?? [],
    firstIncompleteDate: json.metadata?.first_incomplete_date,
  }
}

/** The fields of `indexStatusResult` this code reads, as Google names them. */
export type IndexStatus = {
  verdict?: "VERDICT_UNSPECIFIED" | "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL"
  coverageState?: string
  indexingState?: string
  robotsTxtState?: string
  pageFetchState?: string
  googleCanonical?: string
  userCanonical?: string
  lastCrawlTime?: string
  sitemap?: string[]
}

/** Google's indexed copy only; it cannot test the live page. */
export async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string
): Promise<IndexStatus> {
  const json = await google<{
    inspectionResult?: { indexStatusResult?: IndexStatus }
  }>(accessToken, "POST", INSPECT_URL, { inspectionUrl, siteUrl })
  return json.inspectionResult?.indexStatusResult ?? {}
}
