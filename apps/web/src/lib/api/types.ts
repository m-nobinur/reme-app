import type {
  ApprovalRequest,
  DecisionRequest,
  FactRecord,
} from "@workspace/contracts"

/**
 * What the owner screens read, and the one interface behind them.
 *
 * These types are internal to `apps/web` on purpose. `packages/contracts` has
 * nine schemas and no routes: `paths` in the generated OpenAPI is `{}`, so the
 * generated client C5 was written against does not exist yet, and B5 is the
 * story that publishes the first read endpoints and authors their contract.
 * Writing that contract here, from the consumer side, ahead of the producer,
 * would freeze a boundary we would then rewrite. Ruled on by the architect
 * before this was built.
 *
 * So: where a contract exists it is used rather than shadowed, and
 * `ApprovalRequest`, `InformationRequest` and `FactRecord` come straight from
 * the package. Where none exists yet the shape below is the screen's need and
 * nothing more, and B5 does not inherit it.
 */

export type OrgSummary = {
  id: string
  slug: string
  name: string
}

/** One row of the staff directory (§5.2), flattened for rendering. */
export type StaffMember = {
  id: string
  staffCode: string
  displayName: string
  kind: "agent" | "human"
  positionTitle: string | null
  roleTitle: string | null
  departmentName: string | null
  managerId: string | null
  status: string
}

/** The `manager_id` closure (§5.2), already resolved into a tree. */
export type OrgNode = {
  staff: StaffMember
  reports: OrgNode[]
}

/**
 * The owner attention contract (§7.3): exactly four types, no fifth. A fifth
 * is a product-policy change and an ADR, not a screen decision.
 */
export type AttentionKind = "question" | "approval" | "report" | "alert"

type AttentionBase = {
  id: string
  title: string
  detail: string
  /** Display name of the staff member who raised it. */
  raisedBy: string
  raisedAt: string
  /** Absent only where nothing expires. Every other item carries one (§13). */
  expiresAt: string | null
  /** What happens when it does expire. Never "it goes ahead anyway". */
  onExpiry: string
}

export type AttentionItem =
  | (AttentionBase & { kind: "question" | "report" | "alert" })
  // The approval carries its contract, because the immutable target is drawn
  // from it and a loosened copy could name a different one.
  | (AttentionBase & { kind: "approval"; request: ApprovalRequest })

/** An approval as the inbox renders it: the contract, plus who to name. */
export type ApprovalItem = {
  request: ApprovalRequest
  /** The version number of the revision the approval is bound to. */
  version: number
  /** What the owner is being asked, in one line. */
  title: string
  /** Display name of the staff member who raised it. */
  requestedBy: string
  /** What happens if it expires unanswered. Never "it goes ahead anyway". */
  onExpiry: string
}

/** Where a lead sits in the §4 lifecycle, condensed to what an inbox shows. */
export type PipelineStage =
  | "new"
  | "qualifying"
  | "quoted"
  | "booked"
  | "completed"

export type PipelineItem = {
  id: string
  customer: string
  channel: string
  stage: PipelineStage
  summary: string
  /** The next action and its owner. Every stage has both (§4 step 4). */
  nextAction: string
  ownerStaffName: string
  followUpAt: string | null
  receivedAt: string
}

/**
 * The business profile is canonical facts and nothing else (§10.1, R8). Prices,
 * hours, service area and policies are rendered from `FactRecord` rows with
 * their provenance and version, so a screen cannot show a claim that has no
 * fact behind it.
 */
export type BusinessProfile = {
  org: OrgSummary
  facts: TransportedFact[]
}

/** JSON as it survives a round trip. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json }

/**
 * A `FactRecord` on its way to the browser.
 *
 * Every field is the contract's except one: `value` is `unknown` in the schema,
 * which is right for an opaque jsonb bag and is rejected by TanStack Start's
 * server-function return type, whose serializer refuses `unknown` rather than
 * guessing. Narrowing it to JSON is what the value already is on the wire, and
 * it keeps the rest of the row bound to the contract instead of retyped beside
 * it. Worth knowing before B5 returns contract types straight from a loader.
 */
export type TransportedFact = Omit<FactRecord, "value"> & { value: Json }

/** A single day of activity on the dashboard, read from the event log (§10.6). */
export type ActivityItem = {
  id: string
  summary: string
  occurredAt: string
}

/**
 * Every read the owner screens make. One object, so implementations are
 * interchangeable and `source.ts` is the only file that knows which is in use.
 */
export type OwnerDataSource = {
  /** The organisations the signed-in owner belongs to. */
  orgs: () => Promise<OrgSummary[]>
  staff: (orgId: string) => Promise<StaffMember[]>
  orgTree: (orgId: string) => Promise<OrgNode[]>
  attention: (orgId: string) => Promise<AttentionItem[]>
  approvals: (orgId: string) => Promise<ApprovalItem[]>
  pipeline: (orgId: string) => Promise<PipelineItem[]>
  /** Null where the session has no organisation, the same as `orgs()` empty. */
  profile: (orgId: string) => Promise<BusinessProfile | null>
  activity: (orgId: string) => Promise<ActivityItem[]>
  /**
   * Answer one approval, bound to the revision the owner was shown: the
   * orchestrator refuses a decision whose revision is not the one the review
   * was opened for. Safe to call twice: the same decision on the same
   * revision replays the first one's answer.
   */
  decideApproval: (
    orgId: string,
    approvalId: string,
    revisionId: string,
    decision: DecisionRequest["decision"]
  ) => Promise<void>
}
