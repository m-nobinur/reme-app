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

/**
 * An IANA zone name as `Intl` reports it, such as `Europe/London`. The
 * shape only: the api refuses a name `Intl` rejects.
 */
export const TimeZone = z.string().regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/)

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

/** Free-form JSON bag. Open on purpose: payloads and tool args are not fixed. */
export const JsonObject = z.record(z.string(), z.unknown())

/**
 * What shows an action happened, read back by the code that did it: a page
 * fetched and the status it answered, a job armed and when it runs, or a
 * row written. Never taken from what a model said.
 */
export const Evidence = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("url"),
    url: z
      .string()
      .max(2000)
      .regex(/^https?:\/\/\S+$/),
    status: z.int().min(100).max(599),
    checked_at: Timestamp,
  }),
  z.strictObject({ kind: z.literal("job"), job_id: Uuid, runs_at: Timestamp }),
  z.strictObject({
    kind: z.literal("record"),
    table: z.string().regex(/^[a-z_]{1,63}$/),
    id: Uuid,
  }),
])

/** An action result's evidence: optional, since results stored before it replay. */
export const ActionEvidence = z.array(Evidence).max(4).optional()

export type VersionedRef = z.infer<typeof VersionedRef>
export type ErrorClass = z.infer<typeof ErrorClass>
export type Evidence = z.infer<typeof Evidence>
