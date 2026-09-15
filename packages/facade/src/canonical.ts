/**
 * JSON with every object key sorted and every `undefined` dropped, so the
 * order a value's keys were assigned in can never move a hash or a
 * signature. The same fold `evals/replay.mjs` uses; §10.6 and the spec
 * signature both rest on it, which is why it is exported and tested here
 * rather than inlined twice.
 */
export function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  const body = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
  return `{${body.join(",")}}`
}

const encoder = new TextEncoder()

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")

/** sha256 of the canonical form, as `sha256:<hex>`. Web Crypto, so it runs in a Worker and in Node alike. */
export async function canonicalHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonical(value))
  )
  return `sha256:${hex(digest)}`
}

/** HMAC-SHA256 over the canonical form, hex. */
export async function canonicalHmac(
  value: unknown,
  key: string
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(canonical(value))
    )
  )
}

/** Constant-time string equality, for a MAC compare. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
