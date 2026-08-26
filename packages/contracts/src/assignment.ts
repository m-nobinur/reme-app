import { z } from "zod"
import { JsonObject, Timestamp, Uuid, VersionedRef } from "./common.ts"

/** The §8.4 state machine. Transitions happen only through the orchestrator. */
export const AssignmentState = z.enum([
  "queued",
  "briefing",
  "planning",
  "implementing",
  "validating",
  "preview_ready",
  "awaiting_review",
  "revising",
  "release_candidate",
  "published",
  "blocked_on_information",
  "blocked_on_approval",
  "repairing",
  "paused",
  "failed",
  "cancelled",
])

/**
 * `Assignment` (§19): CoS to orchestrator to runtime. The brief travels as a
 * fact-snapshot reference, not a copy of the facts, so §8.5 content
 * verification has one canonical source to diff against.
 */
export const Assignment = z.strictObject({
  assignment_id: Uuid,
  org_id: Uuid,
  /** Assignee. Targets `staff.id`, so a human occupies the row unchanged. */
  staff_id: Uuid,
  created_by_staff_id: Uuid,
  parent_assignment_id: Uuid.nullable(),
  revision_of_assignment_id: Uuid.nullable(),
  kind: z.string().min(1),
  state: AssignmentState,
  /** Optimistic lock. A transition carrying a stale version is rejected. */
  expected_version: z.int().nonnegative(),
  goal: z.string().min(1),
  /** An assignment nobody can grade is not an assignment. */
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  fact_snapshot_id: Uuid,
  pack_refs: z.array(VersionedRef),
  budget_usd: z.number().positive(),
  deadline: Timestamp.nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  created_at: Timestamp,
  updated_at: Timestamp,
})

/**
 * `InformationRequest` (§7.2): the runtime asks rather than guesses. It names
 * the field it blocks and whether work continues without it, so non-blocking
 * requests batch into one owner question per turn.
 */
export const InformationRequest = z.strictObject({
  request_id: Uuid,
  org_id: Uuid,
  assignment_id: Uuid,
  requested_by_staff_id: Uuid,
  /** The canonical fact key this request would fill. */
  field: z.string().min(1),
  why: z.string().min(1),
  /** JSON Schema the answer must satisfy, so answers validate before storage. */
  answer_schema: JsonObject,
  options: z.array(z.string().min(1)).nullable(),
  blocking: z.boolean(),
  requested_at: Timestamp,
  expires_at: Timestamp.nullable(),
})

/**
 * What an approval binds to (§7.3). A discriminated union, not one object
 * with four optional fields: a stale approval must not be able to name a
 * different target than the one it was granted for.
 */
export const ApprovalTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("revision"), revision_id: Uuid }),
  z.strictObject({ kind: z.literal("domain"), hostname: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("spend"),
    amount_usd: z.number().positive(),
    currency: z.literal("USD"),
  }),
  z.strictObject({
    kind: z.literal("sensitive_claim"),
    fact_id: Uuid,
    claim: z.string().min(1),
  }),
])

/**
 * `ApprovalRequest` (§19, §7.3). Every owner-facing item carries an expiry
 * and an escalation path; nothing auto-publishes when the owner is away.
 */
export const ApprovalRequest = z.strictObject({
  approval_id: Uuid,
  org_id: Uuid,
  assignment_id: Uuid.nullable(),
  requested_by_staff_id: Uuid,
  /** Approver is a staff row, agent or human. */
  approver_staff_id: Uuid,
  action_kind: z.string().min(1),
  target: ApprovalTarget,
  rationale: z.string().min(1),
  requested_at: Timestamp,
  expires_at: Timestamp,
})

export type AssignmentState = z.infer<typeof AssignmentState>
export type Assignment = z.infer<typeof Assignment>
export type InformationRequest = z.infer<typeof InformationRequest>
export type ApprovalTarget = z.infer<typeof ApprovalTarget>
export type ApprovalRequest = z.infer<typeof ApprovalRequest>
