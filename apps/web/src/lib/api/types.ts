import type {
  Activity,
  ApprovalRequest,
  AvatarId,
  BuildStopCause,
  BuildSummary,
  ChangeKind,
  Conversation,
  ConversationMessage,
  ConversationPatch,
  CreateReminderRequest,
  DecisionRequest,
  DerivedReminder,
  DomainCheckout,
  DomainPurchaseStatus,
  FactRecord,
  FactValueKey,
  MemoryReviewAction,
  MemoryView,
  MessageFeedback,
  PushSubscribeRequest,
  RegistrantDetails,
  Reminder,
  WorkspaceStatus,
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
  // A failed build's alert carries why it stopped.
  | (AttentionBase & { kind: "report" | "alert"; stopped?: BuildStopCause })
  // A reminder that came due and is not done; `id` is the reminder's.
  | (AttentionBase & { kind: "reminder" })
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
      /** The pictures the assistant generated for this version (IG4), each with its thumbnail when the api has one. */
      photos?: { slot_id: string; section: string; alt: string; src?: string }[]
    })

/** The frame's one read of `/workspace`: what needs the owner, and where the site is. */
export type Workspace = {
  attention: AttentionItem[]
  /** The version live on the site, or null before the first publish. */
  live: number | null
  /** The live version's revision and the build that made it, to read its screenshots. */
  liveRevision: { revisionId: string; assignmentId: string } | null
  /** A build is doing work now, rather than waiting on the owner or paused. */
  building: boolean
  /** Any build is unfinished, working or not: another must not be offered. */
  open: boolean
  /** Unfinished builds, newest first, as `/workspace` lists them. */
  builds: BuildSummary[]
  /** How long each lane usually takes; absent until the api sends it. */
  expectedSeconds?: WorkspaceStatus["expected_seconds"]
  /** The site's host, once it has one. */
  host: string | null
  /** Where `host` opens: https, or the local router on local dev. Null with `host`. */
  url: string | null
  /** The required facts still to ask for. */
  missingFacts: FactValueKey[]
  /** The name the owner gave their assistant, or null before they chose one. */
  assistantName: string | null
  /** The face the owner picked for their assistant, or null for Reme's own. */
  assistantAvatar: AvatarId | null
  /** Every job as segments with fixed steps; null until the api sends it. */
  activity: Activity | null
  /** What the api derived from rows waiting on the owner, as facts. */
  derivedReminders: DerivedReminder[]
  /** Open reminders someone wrote down, soonest due first, undated after. */
  reminderNotes: Reminder[]
  /** `/workspace`'s tag, sent back on the next poll; null when nothing was read. */
  etag: string | null
}

/** A poll's answer: the workspace, or that it has not changed since `etag`. */
export type WorkspacePoll = Workspace | "unchanged"

/** A signed preview of one revision: the page and its three screenshots. */
export type PreviewLinks = {
  revisionId: string
  url: string
  screenshots: string[]
  /** When the signed URLs stop working. */
  expiresAt: string
}

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

/**
 * What became of a decision. A refusal the owner can act on comes back with
 * its reason; anything else throws.
 */
export type DecisionOutcome =
  | { recorded: true }
  | { recorded: false; reason: "expired" | "replaced" | "gone" | "checking" }

/**
 * Every read the owner screens make. One object, so implementations are
 * interchangeable and `source.ts` is the only file that knows which is in use.
 */
export type OwnerDataSource = {
  /**
   * The session's organisation: at most one, because that is what a
   * session's `org_id` claim resolves to and what signup creates.
   */
  org: () => Promise<OrgSummary | null>
  staff: () => Promise<StaffMember[]>
  /** The directory and its reporting lines, from one read. */
  directory: () => Promise<{ staff: StaffMember[]; tree: OrgNode[] }>
  /** `staff` is the directory the caller has already read, for names. */
  workspace: (staff: Promise<StaffMember[]>) => Promise<Workspace>
  pipeline: () => Promise<PipelineItem[]>
  /** Null where the session has no organisation, the same as `org()`. */
  profile: () => Promise<BusinessProfile | null>
  /** What the Chief of Staff remembers of the owner, or null where the session has no organisation. */
  memory: () => Promise<MemoryView | null>
  /**
   * Undoes one remembered change. "stale" when it was already undone or
   * edited since, so nothing is left to undo.
   */
  undoMemory: (version: number) => Promise<MemoryView | "stale" | null>
  /** The owner's choice about asking first, or their answer to one proposal. "stale" when it is gone. */
  reviewMemory: (
    action: MemoryReviewAction
  ) => Promise<MemoryView | "stale" | null>
  /** Reports and alerts from the last 30 days, newest first as listed. */
  activity: () => Promise<AttentionItem[]>
  /**
   * Answer one approval, bound to the revision the owner was shown: the
   * orchestrator refuses a decision whose revision is not the one the review
   * was opened for. Safe to call twice: the same decision on the same
   * revision replays the first one's answer.
   */
  decideApproval: (
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
    assignmentId: string,
    requestId: string,
    value: unknown,
    key: string
  ) => Promise<WriteOutcome>
  cancelBuild: (assignmentId: string) => Promise<WriteOutcome>
  /** The owner's own account, ended (ADR-035). A second call finishes the first. */
  deleteAccount: () => Promise<WriteOutcome>
  preview: (assignmentId: string) => Promise<PreviewLinks | null>
  /** A reminder the owner wrote. Idempotent on `key`. */
  createReminder: (
    input: CreateReminderRequest,
    key: string
  ) => Promise<WriteOutcome>
  /** The VAPID public key a browser subscribes with, or null where push is off. */
  pushKey: () => Promise<string | null>
  /** Saves this browser for push. Its id, or null when the api refused it. */
  subscribePush: (
    input: PushSubscribeRequest,
    key: string
  ) => Promise<string | null>
  unsubscribePush: (id: string) => Promise<WriteOutcome>
  /** A domain purchase's Checkout, or the api's refusal code. Keyed by `key`. */
  domainCheckout: (
    name: string,
    details: RegistrantDetails,
    key: string
  ) => Promise<DomainCheckout | { refused: string | null }>
  /**
   * Hands Google's one-time code to the api, which connects the owner's Search
   * Console. Never throws: anything but a connection or a missing scope is `failed`.
   */
  googleConnect: (input: {
    code: string
    verifier: string
    redirect_uri: string
  }) => Promise<"connected" | "scopes_missing" | "failed">
  /** The newest purchase of a domain, or null when there is none. */
  domainStatus: (name: string) => Promise<DomainPurchaseStatus | null>
  /** Mark one reminder done. Doing it twice changes nothing. */
  completeReminder: (id: string) => Promise<WriteOutcome>
  /** What the owner wants changed, in their words; the api routes it. */
  requestChange: (
    text: string,
    key: string,
    changeKind?: ChangeKind,
    /** Also posts the words in the chat, in this conversation or the newest. */
    chat?: { conversation_id?: string }
  ) => Promise<WriteOutcome>
  conversations: () => Promise<Conversation[]>
  conversation: (id: string) => Promise<Conversation | null>
  /**
   * Idempotent on `key`, the thread's local id: a retry returns the same row.
   * Null for a session with no organisation, which has nowhere to store one.
   */
  createConversation: (key: string) => Promise<Conversation | null>
  updateConversation: (
    id: string,
    patch: ConversationPatch,
    key: string
  ) => Promise<void>
  conversationMessages: (id: string) => Promise<TransportedMessage[]>
  /** The owner's thumb on a reply. `key` is the press's own, so a replay records nothing. */
  rateMessage: (
    id: string,
    feedback: MessageFeedback,
    key: string
  ) => Promise<void>
  /**
   * One chat turn, its JSON body as the owner sent it, answered as
   * `apps/api` answers it: the stream on success, the refusal otherwise,
   * passed back whole. Null when there is no session.
   */
  chat: (body: string) => Promise<Response | null>
  /**
   * The owner's photos, the multipart body streamed through as the browser
   * sent it, answered as `apps/api`'s `POST /assets` answers. Null when
   * there is no session.
   */
  assets: (upload: {
    body: ReadableStream<Uint8Array>
    type: string
    length: number
    key: string
  }) => Promise<Response | null>
  /**
   * One generated or uploaded image of the owner's org, answered as
   * `apps/api`'s `GET /photos/:id` answers. Null when there is no session.
   */
  photo: (assetId: string) => Promise<Response | null>
  /**
   * The design tray's photos read against the photo needs, the JSON body as
   * the owner sent it, answered as `apps/api`'s `POST /assets/review`
   * answers. Null when there is no session.
   */
  reviewPhotos: (body: string, key: string) => Promise<Response | null>
  /**
   * The colours in one picture, streamed through as the browser sent it and
   * never stored, answered as `POST /palettes/from-image` answers. Null when
   * there is no session.
   */
  paletteFromImage: (upload: {
    body: ReadableStream<Uint8Array>
    type: string
    length: number
    key: string
  }) => Promise<Response | null>
  /** The kept logo read into palettes, answered as `POST /palettes/from-logo` answers. Null when there is no session. */
  logoPalettes: (body: string) => Promise<Response | null>
  /** A round of logos started, answered as `POST /logos` answers. Null when there is no session. */
  drawLogos: (body: string, key: string) => Promise<Response | null>
  /** One logo question's rounds, answered as `GET /logos` answers. Null when there is no session. */
  logoRounds: (toolCallId: string) => Promise<Response | null>
  /** A variant or an upload kept as the logo, answered as `POST /logos/{id}/keep`. Null when there is no session. */
  keepLogo: (id: string, key: string) => Promise<Response | null>
}
