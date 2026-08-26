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
