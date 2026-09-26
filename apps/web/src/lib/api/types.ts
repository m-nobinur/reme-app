import type {
  ApprovalRequest,
  BuildSummary,
  Conversation,
  ConversationMessage,
  ConversationPatch,
  DecisionRequest,
  FactRecord,
  FactValueKey,
} from "@workspace/contracts"
import type { AnswerSpec } from "@workspace/ui/lib/answer"

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
  /**
   * The staff row that raised it, for a reader that holds the directory: a
   * poll names no one, so the panel names the asker from the frame's read.
   */
  raisedById: string | null
  raisedAt: string
  /** Absent only where nothing expires. Every other item carries one (§13). */
  expiresAt: string | null
  /** What happens when it does expire. Never "it goes ahead anyway". */
  onExpiry: string
}

export type AttentionItem =
  | (AttentionBase & { kind: "report" | "alert" })
  // A question carries what answering it needs: the build it blocks, and the
  // inputs, derived on the server so the raw `answer_schema` never travels.
  | (AttentionBase & {
      kind: "question"
      assignmentId: string
      answer: AnswerSpec
    })
  // The approval carries its contract, because the immutable target is drawn
  // from it and a loosened copy could name a different one.
  | (AttentionBase & {
      kind: "approval"
      request: ApprovalRequest
      /** The version number of the revision the approval is bound to. */
      version: number
    })

/** The frame's one read of `/workspace`: what needs the owner, and where the site is. */
export type Workspace = {
  attention: AttentionItem[]
  /** The version live on the site, or null before the first publish. */
  live: number | null
  /** A build is doing work now, rather than waiting on the owner or paused. */
  building: boolean
  /** Any build is unfinished, working or not: another must not be offered. */
  open: boolean
  /** Unfinished builds, newest first, as `/workspace` lists them. */
  builds: BuildSummary[]
  /** The site's host, once it has one. */
  host: string | null
  /** The required facts still to ask for. */
  missingFacts: FactValueKey[]
  /** `/workspace`'s tag, sent back on the next poll; null when nothing was read. */
  etag: string | null
}

/** A poll's answer: the workspace, or that it has not changed since `etag`. */
export type WorkspacePoll = Workspace | "unchanged"

/** A signed preview of one revision: the page and its three screenshots. */
export type PreviewLinks = { url: string; screenshots: string[] }

/**
 * What became of an owner's write. A refusal the owner can act on comes
 * back with the words to show; anything else throws.
 */
export type WriteOutcome =
  | { done: true }
  // `gone`: what the owner acted on no longer waits on them (a different
  // answer is on record, say), so the screen reads the workspace again.
  | { done: false; reason: string; gone?: true }

/**
 * A stored message on its way to the browser. Parts are the AI SDK's and
 * open-ended, so they travel as JSON, the way `TransportedFact` does.
 */
export type TransportedMessage = Omit<ConversationMessage, "content"> & {
  content: Omit<ConversationMessage["content"], "parts"> & {
    parts: ({ type: string } & { [key: string]: Json })[]
  }
}

/** An approval as the inbox renders it: the contract, plus who to name. */
export type ApprovalItem = {
  request: ApprovalRequest
  /** The version number of the revision the approval is bound to. */
  version: number
  /** The revision a decision names, read from `request.target`. */
  revisionId: string
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
 * What became of a decision. A refusal the owner can act on comes back with
 * its reason; anything else throws.
 */
export type DecisionOutcome =
  | { recorded: true }
  | { recorded: false; reason: "expired" | "replaced" | "gone" }

/**
 * Every read the owner screens make. One object, so implementations are
 * interchangeable and `source.ts` is the only file that knows which is in use.
 */
export type OwnerDataSource = {
  /** The organisations the signed-in owner belongs to. */
  orgs: () => Promise<OrgSummary[]>
  staff: (orgId: string) => Promise<StaffMember[]>
  orgTree: (orgId: string) => Promise<OrgNode[]>
  /** `staff` is the directory the caller has already read, for names. */
  workspace: (
    orgId: string,
    staff: Promise<StaffMember[]>
  ) => Promise<Workspace>
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
  ) => Promise<DecisionOutcome>
  /**
   * `/workspace` again, or "unchanged" when it still matches `etag`. One
   * request: the api reads the org from the session, and nothing is named.
   */
  pollWorkspace: (etag: string | null) => Promise<WorkspacePoll>
  answer: (
    orgId: string,
    assignmentId: string,
    requestId: string,
    value: unknown,
    key: string
  ) => Promise<WriteOutcome>
  cancelBuild: (orgId: string, assignmentId: string) => Promise<WriteOutcome>
  preview: (orgId: string, assignmentId: string) => Promise<PreviewLinks | null>
  /** What the owner wants changed, in their words; the api routes it. */
  requestChange: (
    orgId: string,
    text: string,
    key: string
  ) => Promise<WriteOutcome>
  conversations: (orgId: string) => Promise<Conversation[]>
  conversation: (orgId: string, id: string) => Promise<Conversation | null>
  /** Idempotent on `key`, the thread's local id: a retry returns the same row. */
  createConversation: (orgId: string, key: string) => Promise<Conversation>
  updateConversation: (
    orgId: string,
    id: string,
    patch: ConversationPatch,
    key: string
  ) => Promise<void>
  conversationMessages: (
    orgId: string,
    id: string
  ) => Promise<TransportedMessage[]>
}
