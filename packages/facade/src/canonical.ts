import { createHash, createHmac } from "node:crypto"

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

/**
 * sha256 of the canonical form, as `sha256:<hex>`. Synchronous on purpose:
 * the spec is verified inside an agent render, which cannot await, and
 * `node:crypto` is available to a Worker under `nodejs_compat`.
 */
export function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`
}

/** HMAC-SHA256 over the canonical form, hex. */
export function canonicalHmac(value: unknown, key: string): string {
  return createHmac("sha256", key).update(canonical(value)).digest("hex")
}

/** Constant-time string equality, for a MAC compare. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
