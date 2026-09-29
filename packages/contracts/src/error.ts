import { z } from "zod"
import { ErrorClass, JsonObject, Timestamp, Ulid, Uuid } from "./common.ts"

/**
 * The §28.1 error envelope. Not a cross-team payload in its own right, which
 * is why §19 does not table it; it is the shape every typed error takes
 * before it is logged or wrapped in a `FailureReport` (R4).
 */
export const ErrorEnvelope = z.strictObject({
  class: ErrorClass,
  /** Stable machine code, e.g. `capability.denied`. Never a message string. */
  code: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /** Human-readable and safe to show. Never a raw exception or a stack. */
  message: z.string().min(1),
  occurred_at: Timestamp,
  detail: JsonObject,
})

/**
 * `FailureReport` (§19) is the only failure shape that crosses a boundary.
 * `last_checkpoint_ref` is a reference, never a body (R8).
 */
export const FailureReport = z.strictObject({
  failure_id: Ulid,
  org_id: Uuid,
  staff_id: Uuid.nullable(),
  assignment_id: Uuid.nullable(),
  error: ErrorEnvelope,
  /** What went wrong in terms the CoS can act on, per §13 rule 4. */
  diagnosis: z.string().min(1),
  last_checkpoint_ref: z.string().min(1).nullable(),
  /** Repair attempts are bounded at N=3 per assignment (§8.4). */
  attempt: z.int().positive(),
  reported_at: Timestamp,
})

export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>
export type FailureReport = z.infer<typeof FailureReport>

/** An envelope without its timestamp: what a caller writes before `envelope` stamps it. */
export type EnvelopeBody = Omit<ErrorEnvelope, "occurred_at">

/** R4: `body` as the §28.1 envelope, stamped now. */
export const envelope = (body: EnvelopeBody): ErrorEnvelope => ({
  ...body,
  occurred_at: new Date().toISOString(),
})

/** What every Worker's catch-all answers with a 503, once it has logged the code. */
export const REQUEST_FAILED = {
  class: "transient",
  code: "request.failed",
  message: "The request could not be completed.",
  detail: {},
} as const satisfies EnvelopeBody

/** The 400 body for a mutating request without a usable Idempotency-Key (R5). */
export const KEY_MISSING = {
  class: "validation",
  code: "idempotency_key.missing",
  message: "This request needs an Idempotency-Key header.",
  detail: {},
} as const satisfies EnvelopeBody

/** The caller's `Idempotency-Key`, or null for a missing or oversized one. */
export function idempotencyKey(request: { headers: Headers }): string | null {
  const key = request.headers.get("idempotency-key")?.trim()
  return key && key.length <= 255 ? key : null
}
