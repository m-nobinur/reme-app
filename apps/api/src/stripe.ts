/**
 * Stripe over `fetch` with the Worker's secret key, and the webhook
 * signature check on WebCrypto. No SDK: two calls and one HMAC do not
 * justify its bundle.
 *
 * shortcut: one test-mode secret key per Worker stands in for the plan's
 * restricted keys split by Worker; make restricted keys when live keys are
 * made.
 */

/** Pinned, so a change of the account's default version changes nothing here. */
export const STRIPE_VERSION = "2026-08-26.dahlia"

/** How old a signed webhook may be, Stripe's own default. */
export const SIGNATURE_TOLERANCE_S = 300

/** A Stripe call that did not answer 2xx: its status and Stripe's error code. */
export class StripeFailed extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`stripe ${status} ${code}`)
  }
}

type Param = string | number | boolean | undefined | Param[] | ParamObject
type ParamObject = { [key: string]: Param }

/** Stripe's form encoding: `a[b][0][c]=v`, with undefined left out. */
export function form(params: ParamObject): URLSearchParams {
  const out = new URLSearchParams()
  const walk = (value: Param, key: string) => {
    if (value === undefined) return
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(v, `${key}[${i}]`)
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        walk(v, key ? `${key}[${k}]` : k)
      }
    } else out.append(key, String(value))
  }
  walk(params, "")
  return out
}

/**
 * One call to `https://api.stripe.com/v1/{path}`: a POST of `params`, keyed
 * when `key` is given, or a GET without them.
 */
export async function stripe<T>(
  secretKey: string,
  path: string,
  params?: ParamObject,
  key?: string
): Promise<T> {
  const headers = new Headers({
    authorization: `Bearer ${secretKey}`,
    "stripe-version": STRIPE_VERSION,
  })
  if (params) {
    headers.set("content-type", "application/x-www-form-urlencoded")
  }
  if (key) headers.set("idempotency-key", key)
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? "POST" : "GET",
    headers,
    body: params ? form(params) : null,
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; type?: string }
  } | null
  if (!response.ok) {
    throw new StripeFailed(
      response.status,
      body?.error?.code ?? body?.error?.type ?? "unknown"
    )
  }
  return body as T
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

/** Equal strings in time that does not depend on where they differ. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Whether `header` (`t=…,v1=…[,v1=…]`) signs `raw` with `secret`: HMAC-SHA256
 * of `{t}.{raw}`, any `v1` matching, and `t` within the tolerance of `now`
 * (seconds) either way. A second `v1` is a rolled secret's.
 */
export async function verifyStripeSignature(
  raw: string,
  header: string | null,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!header) return false
  const pairs = header.split(",").map((part) => part.split("=", 2))
  const t = pairs.find(([k]) => k === "t")?.[1] ?? ""
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v ?? "")
  if (!/^\d+$/.test(t) || signatures.length === 0) return false
  if (Math.abs(now - Number(t)) > SIGNATURE_TOLERANCE_S) return false
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const expected = hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${t}.${raw}`)
    )
  )
  return signatures.some((s) => same(s, expected))
}
