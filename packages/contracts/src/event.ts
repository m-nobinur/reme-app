import { z } from "zod"
import { JsonObject, Timestamp, Ulid, Uuid } from "./common.ts"

/**
 * Taint labels travel with the event so retrieval and the content gate can
 * refuse to promote untrusted material (§28.3).
 */
export const TaintLabel = z.enum([
  "untrusted_input",
  "external_content",
  "inferred",
  "quarantined",
])

/**
 * `EventEnvelope` (§19) wraps every queue message and every event-log row
 * (R4). Store 6 is the system of record for context derivation (§10.6), so an
 * event that is not appended here is not model-visible.
 */
export const EventEnvelope = z.strictObject({
  event_id: Ulid,
  org_id: Uuid,
  staff_id: Uuid.nullable(),
  assignment_id: Uuid.nullable(),
  session_id: Uuid.nullable(),
  /** Monotonic per aggregate. Out-of-order appends are rejected (§13). */
  seq: z.int().nonnegative(),
  /** Dotted event key, e.g. `assignment.state_changed`. */
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  occurred_at: Timestamp,
  /** Consumers upsert by this key and are safe to run twice (R5). */
  idempotency_key: Ulid,
  taint: z.array(TaintLabel),
  payload: JsonObject,
})

export type TaintLabel = z.infer<typeof TaintLabel>
export type EventEnvelope = z.infer<typeof EventEnvelope>
