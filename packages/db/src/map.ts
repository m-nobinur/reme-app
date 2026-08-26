import type { EventEnvelope, FactRecord } from "@workspace/contracts"
import type { events, facts } from "./schema.ts"

/**
 * Row to contract. Two shapes exist in both `packages/contracts` and this
 * schema, and these are the only two places they are allowed to meet: the
 * contract stays the wire shape, the table stays the storage shape, and
 * `test/contract-alignment.test.ts` fails if they drift apart.
 */

/** Contract timestamps are RFC 3339 with an offset, never a `Date`. */
const iso = (at: Date | null) => (at === null ? null : at.toISOString())

/** `provenance` is four columns here and one nested object on the wire. */
export function toFactRecord(row: typeof facts.$inferSelect): FactRecord {
  return {
    fact_id: row.id,
    org_id: row.orgId,
    key: row.key,
    fact_type: row.factType,
    value: row.value,
    version: row.version,
    provenance: {
      source: row.provenanceSource,
      confidence: row.provenanceConfidence,
      verified_by_staff_id: row.verifiedByStaffId,
      verified_at: iso(row.verifiedAt),
    },
    valid_from: row.validFrom.toISOString(),
    valid_to: iso(row.validTo),
    superseded_by_fact_id: row.supersededByFactId,
  }
}

/** `recorded_at` stays behind: when we appended is ours, not the producer's. */
export function toEventEnvelope(
  row: typeof events.$inferSelect
): EventEnvelope {
  return {
    event_id: row.eventId,
    org_id: row.orgId,
    staff_id: row.staffId,
    assignment_id: row.assignmentId,
    session_id: row.sessionId,
    seq: row.seq,
    type: row.type,
    occurred_at: row.occurredAt.toISOString(),
    idempotency_key: row.idempotencyKey,
    taint: row.taint,
    payload: row.payload,
  }
}
