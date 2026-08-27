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
export const EventEnvelope = z
  .strictObject({
    event_id: Ulid,
    org_id: Uuid,
    staff_id: Uuid.nullable(),
    assignment_id: Uuid.nullable(),
    session_id: Uuid.nullable(),
    /**
     * The position in the session's stream, monotonic within it, and NULL for
     * an event that belongs to no session (ADR-028). The aggregate is the
     * session because that is what §10.6 replays: `deriveContext` reads a
     * session's events, so a session is the only stream whose position carries
     * a meaning. Out-of-order appends are rejected (§13) by comparing against
     * the session's last `seq`. Ordering across sessions comes from `event_id`,
     * which is a ULID and sorts by append time.
     */
    seq: z.int().nonnegative().nullable(),
    /** Dotted event key, e.g. `assignment.state_changed`. */
    type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    occurred_at: Timestamp,
    /** Consumers upsert by this key and are safe to run twice (R5). */
    idempotency_key: Ulid,
    taint: z.array(TaintLabel),
    payload: JsonObject,
  })
  .check((ctx) => {
    if ((ctx.value.session_id === null) !== (ctx.value.seq === null)) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["seq"],
        message:
          "seq is the position in a session's stream: set both session_id " +
          "and seq, or neither",
      })
    }
  })
  // The same rule for a consumer that only ever sees the published JSON
  // Schema. A `.check()` is invisible to `z.toJSONSchema`, and metadata is
  // copied into the emitted component verbatim, so this is where the pairing
  // reaches another language. `test/round-trip.test.ts` drives both halves
  // against the same cases, which is what stops the two drifting apart.
  //
  // Wrapped in an `allOf` rather than written as a bare `anyOf`, because
  // openapi-typescript turns a bare one into a union with the whole object and
  // every required field becomes optional. As an `allOf` it emits the object
  // intersected with the pair, so the generated type rejects a seq with no
  // session too.
  .meta({
    allOf: [
      {
        anyOf: [
          {
            properties: { session_id: { type: "null" }, seq: { type: "null" } },
          },
          {
            properties: {
              session_id: { type: "string" },
              seq: { type: "integer" },
            },
          },
        ],
      },
    ],
  })

export type TaintLabel = z.infer<typeof TaintLabel>
export type EventEnvelope = z.infer<typeof EventEnvelope>
