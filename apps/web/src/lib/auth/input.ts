/**
 * Reading a string off a server function's payload.
 *
 * The payload is whatever the network sent, so every field is `unknown` until
 * proved otherwise. Non-strings become empty rather than `String(value)`, which
 * would turn `{}` into "[object Object]" and send it to WorkOS as an email.
 *
 * The cap is not cosmetic. An unbounded password field is a free way to make
 * the server hash megabytes, and an unbounded email is a free way to fill a
 * log line. 512 is longer than any real value here and shorter than anything
 * worth forwarding.
 */
export function text(value: unknown, max = 512): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

/** Passwords keep their whitespace: a leading space is a legitimate character. */
export function secret(value: unknown, max = 512): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

/** A one-time code: digits only, at most six of them. */
export function digits(value: unknown, max = 6): string {
  return typeof value === "string" ? value.replace(/\D/g, "").slice(0, max) : ""
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}
