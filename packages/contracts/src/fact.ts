import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"

/**
 * §10.2. `inferred` facts may never reach a tenant-visible surface; the
 * content gate checks the provenance class before the claim (R8, §8.5).
 */
export const FactProvenance = z.strictObject({
  source: z.enum(["owner_stated", "document", "integration", "inferred"]),
  confidence: z.number().min(0).max(1),
  verified_by_staff_id: Uuid.nullable(),
  verified_at: Timestamp.nullable(),
})

/**
 * `FactRecord` (§19, store 1). Versioned and never overwritten: a contradicting
 * statement supersedes the losing version after an owner confirmation, so the
 * history stays intact and a stale render is diagnosable.
 */
export const FactRecord = z.strictObject({
  fact_id: Uuid,
  org_id: Uuid,
  /** Canonical key, e.g. `hours.tuesday_close`. */
  key: z.string().min(1),
  /** Domain classification the packs validate against, e.g. `service_area`. */
  fact_type: z.string().min(1),
  /** Opaque jsonb. The domain pack validates it against `fact_type`. */
  value: z.unknown(),
  version: z.int().positive(),
  provenance: FactProvenance,
  valid_from: Timestamp,
  valid_to: Timestamp.nullable(),
  superseded_by_fact_id: Uuid.nullable(),
})

/**
 * `FactSnapshot` (§8.5, §19): the facts an assignment was briefed with,
 * frozen at Briefing so the Developer, the facade's prompt and the content
 * gate all read one thing. `Assignment.fact_snapshot_id` names it; the
 * orchestrator writes it as a `facts.snapshot_taken` event, the facade
 * renders it into the stable prompt segment, P1's gate diffs the built HTML
 * against it. Only current versions belong here: `valid_to` is null on every
 * record. Ceiling to write down rather than build for: when an org's
 * snapshot no longer fits `ContextPolicy.max_input_tokens`, it becomes a set
 * of refs and this shape is revisited.
 */
export const FactSnapshot = z.strictObject({
  snapshot_id: Uuid,
  org_id: Uuid,
  assignment_id: Uuid,
  taken_at: Timestamp,
  facts: z.array(FactRecord),
})

export type FactProvenance = z.infer<typeof FactProvenance>
export type FactRecord = z.infer<typeof FactRecord>
export type FactSnapshot = z.infer<typeof FactSnapshot>
