import type {
  Assignment,
  EventEnvelope,
  FactRecord,
  Org,
  SiteRevision,
  StaffMember,
} from "@workspace/contracts"
import type {
  assignments,
  events,
  facts,
  orgs,
  siteRevisions,
  staff,
} from "./schema.ts"

/**
 * Row to contract. Four shapes exist in both `packages/contracts` and this
 * schema, and these are the only places they are allowed to meet: the contract
 * stays the wire shape, the table stays the storage shape, and
 * `test/contract-alignment.test.ts` fails if they drift apart.
 */

/** Contract timestamps are RFC 3339 with an offset, never a `Date`. */
const iso = (at: Date | null) => (at === null ? null : at.toISOString())

/**
 * The tenant root, as a screen shows it. `workos_organization_id` stays behind:
 * which identity provider an org is mirrored from is ours, not the app's, and
 * nothing on a page has any use for it.
 */
export function toOrg(row: typeof orgs.$inferSelect): Org {
  return {
    org_id: row.id,
    slug: row.slug,
    name: row.name,
    created_at: row.createdAt.toISOString(),
  }
}

/** `manager_id` and `id` are named for the tree they are in on the wire. */
export function toStaffMember(row: typeof staff.$inferSelect): StaffMember {
  return {
    staff_id: row.id,
    org_id: row.orgId,
    staff_code: row.staffCode,
    display_name: row.displayName,
    kind: row.kind,
    status: row.status,
    position_title: row.positionTitle,
    manager_staff_id: row.managerId,
    role_id: row.roleId,
    department_id: row.departmentId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

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

/** `version` is `expected_version` on the wire: the lock a caller must echo. */
export function toAssignment(row: typeof assignments.$inferSelect): Assignment {
  return {
    assignment_id: row.id,
    org_id: row.orgId,
    staff_id: row.staffId,
    created_by_staff_id: row.createdByStaffId,
    parent_assignment_id: row.parentAssignmentId,
    revision_of_assignment_id: row.revisionOfAssignmentId,
    kind: row.kind,
    state: row.state,
    expected_version: row.version,
    goal: row.goal,
    acceptance_criteria: row.acceptanceCriteria,
    fact_snapshot_id: row.factSnapshotId,
    pack_refs: row.packRefs,
    budget_usd: row.budgetUsd,
    deadline: iso(row.deadline),
    priority: row.priority,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export function toSiteRevision(
  row: typeof siteRevisions.$inferSelect
): SiteRevision {
  return {
    revision_id: row.id,
    org_id: row.orgId,
    site_id: row.siteId,
    assignment_id: row.assignmentId,
    version: row.version,
    summary: row.summary,
    source_key: row.sourceKey,
    artifact_prefix: row.artifactPrefix,
    manifest_key: row.manifestKey,
    status: row.status,
    retire_after: iso(row.retireAfter),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}
