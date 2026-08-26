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

export type FactProvenance = z.infer<typeof FactProvenance>
export type FactRecord = z.infer<typeof FactRecord>
