import { type EnvelopeBody, envelope, KEY_MISSING } from "@workspace/contracts"
import { pgCode } from "@workspace/db"

/** R4: every failure leaves as the §28.1 envelope, never a raw exception. */
export function failure(status: number, body: EnvelopeBody): Response {
  return Response.json(envelope(body), { status })
}

export const keyMissing = () => failure(400, KEY_MISSING)

/** Where a contract parse failed, as dotted paths and never the values. */
export const issuePaths = (issues: { path: PropertyKey[] }[] = []) =>
  issues.map((i) => i.path.join("."))

/** A body the contract refused, naming the paths it refused and nothing else. */
export const invalid = (issues: { path: PropertyKey[] }[]) =>
  failure(400, {
    class: "validation",
    code: "request.invalid",
    message: "The request body does not match the contract.",
    detail: { issues: issuePaths(issues) },
  })

/** The largest request body any route reads: 64 KiB, far above any contract's. */
export const BODY_MAX = 64 * 1024

export const tooLarge = () =>
  failure(413, {
    class: "validation",
    code: "request.too_large",
    message: `A request body is at most ${BODY_MAX / 1024} KiB.`,
    detail: { max_bytes: BODY_MAX },
  })

/** Thrown by `readBody` over the cap; `index.ts` answers it with 413. */
export class BodyTooLarge extends Error {}

/**
 * A route's JSON body, read after the route has authenticated the caller and
 * no further than `BODY_MAX`. Null for a body that is not JSON, so the
 * contract parse refuses it; `BodyTooLarge` for one over the cap.
 */
export async function readBody(request: Request): Promise<unknown> {
  const bytes = await boundedBody(request)
  if (!bytes) throw new BodyTooLarge()
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/**
 * The body, read no further than `BODY_MAX`, or null when it is longer. The
 * declared length refuses early; the count refuses a body that declared none.
 */
export async function boundedBody(
  request: Request
): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > BODY_MAX) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > BODY_MAX) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/**
 * Keys in code-point order at every depth, for `JSON.stringify`. jsonb keeps
 * its own key order, so a value read back from the database gives the bytes
 * of the value written only when its keys are sorted.
 */
export const sortedKeys = (_key: string, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    : value

/** Every error shape postgres.js can be wrapped in on the way out of drizzle. */
export const constraint = (error: unknown) => {
  const e = error as {
    constraint_name?: string
    cause?: { constraint_name?: string }
  }
  return {
    code: pgCode(error),
    name: e.constraint_name ?? e.cause?.constraint_name,
  }
}

/** The SHA-256 of `text`'s UTF-8 bytes, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * The keys a provider's own data travels under on a chunk or a part in ai
 * 7.0.83. The provider puts the model's reasoning there (OpenRouter's
 * `reasoning_details`), so none of it reaches the owner or a stored row; the
 * Chief of Staff's log keeps it, since the provider needs it sent back.
 */
const PROVIDER_KEYS = [
  "providerMetadata",
  "callProviderMetadata",
  "resultProviderMetadata",
] as const

/** `value` without the provider's data. */
export function withoutProviderData<T extends object>(value: T): T {
  const copy = { ...value } as Record<string, unknown>
  for (const key of PROVIDER_KEYS) delete copy[key]
  return copy as T
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * A client's Idempotency-Key as an event's key: 26 Crockford characters from
 * the SHA-256 of `scope` and the key, so it fits `events.idempotency_key`
 * (a ULID's shape) and the org's unique index refuses a replay. The scope
 * keeps one route's keys apart from another's.
 */
export async function eventKey(scope: string, key: string): Promise<string> {
  const hex = await sha256Hex(`${scope}:${key}`)
  // 128 bits as 26 base-32 digits: the first digit holds the top 3 bits of
  // 130, so it is at most 3, inside a ULID's 0 to 7.
  let n = BigInt(`0x${hex.slice(0, 32)}`)
  let out = ""
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n % 32n)] + out
    n /= 32n
  }
  return out
}

/** The longest title made from an owner's first message, in characters. */
export const TITLE_MAX = 59

/**
 * A conversation's title from the owner's first message: its first line,
 * without control characters or bidi controls, whitespace collapsed, cut
 * at a word boundary to under 60 characters. Null when nothing is left.
 * The owner's own words, stored and shown as plain text only.
 */
export function titleFrom(text: string): string | null {
  const firstLine = text.split(/\r\n|\r|\n|\u2028|\u2029/, 1)[0] ?? ""
  const clean = firstLine
    .replace(/[\p{Cc}\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  const chars = [...clean]
  if (chars.length === 0) return null
  if (chars.length <= TITLE_MAX) return clean
  const head = chars.slice(0, TITLE_MAX + 1).join("")
  const space = head.lastIndexOf(" ")
  return space > 0
    ? head.slice(0, space).trimEnd()
    : chars.slice(0, TITLE_MAX).join("")
}
