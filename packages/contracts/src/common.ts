import { z } from "zod"

/**
 * Shared field-level building blocks. Every contract is a `strictObject`: an
 * unknown key is a validation error, not silently dropped data, and that is
 * what makes the Zod schema and the emitted JSON Schema mean the same thing.
 */

/** Postgres primary keys (§5.2). */
export const Uuid = z.uuid()

/** Idempotency keys and event ids (§13.1). Crockford base32, 26 chars. */
export const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)

/** RFC 3339 with an offset. Never a `Date`: contracts cross JSON boundaries. */
export const Timestamp = z.iso.datetime({ offset: true })

/** A registry entry pinned to a version (§5.3): packs and skills. */
export const VersionedRef = z.strictObject({
  key: z.string().min(1),
  version: z.string().min(1),
})

/** §28.1 error taxonomy. The class decides the disposition. */
export const ErrorClass = z.enum([
  "validation",
  "permission",
  "transient",
  "resource",
  "provider",
  "integrity",
  "security",
  "budgetary",
])

/**
 * Retryability is derived from the class, never carried as a field that could
 * contradict it. `provider` is retryable only through the §28.2 fallback
 * chain; `resource` needs a decision, so neither is listed here.
 */
export const RETRYABLE_ERROR_CLASSES = ["transient", "provider"] as const

/** Free-form JSON bag. Open on purpose: payloads and tool args are not fixed. */
export const JsonObject = z.record(z.string(), z.unknown())

export type VersionedRef = z.infer<typeof VersionedRef>
export type ErrorClass = z.infer<typeof ErrorClass>
